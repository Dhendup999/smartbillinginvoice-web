/**
 * Database writes/reads for Paddle billing state (customers, subscriptions, processed events).
 */
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers, subscriptions, webhookEvents } from "../../db/schema.js";
import { MONTHLY_PRICE_ID, YEARLY_PRICE_ID } from "./paddle.js";

const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** MONTHLY / YEARLY from Paddle line items (price ID first, billing interval as fallback). */
export function planFromItems(items: any[] | undefined): "MONTHLY" | "YEARLY" | null {
  for (const item of Array.isArray(items) ? items : []) {
    const pId = item?.price?.id || item?.price_id || "";
    if (pId === MONTHLY_PRICE_ID) return "MONTHLY";
    if (pId === YEARLY_PRICE_ID) return "YEARLY";
  }
  for (const item of Array.isArray(items) ? items : []) {
    const interval = item?.price?.billing_cycle?.interval || "";
    if (interval === "month") return "MONTHLY";
    if (interval === "year") return "YEARLY";
  }
  return null;
}

export function normalizeStoreId(raw: unknown): string | null {
  const s = String(raw || "").trim().toUpperCase();
  return /^RTL-[0-9A-F]{4}-[0-9A-F]{4}$/.test(s) ? s : null;
}

export async function isEventProcessed(eventId: string): Promise<boolean> {
  if (!eventId) return false;
  const rows = await db.select({ id: webhookEvents.id }).from(webhookEvents).where(eq(webhookEvents.id, eventId)).limit(1);
  return rows.length > 0;
}

export async function recordEvent(e: { id: string; type: string; entityId?: string; occurredAt?: string; result: string }) {
  if (!e.id) return;
  await db
    .insert(webhookEvents)
    .values({ id: e.id, eventType: e.type, entityId: e.entityId || null, occurredAt: toDate(e.occurredAt), result: e.result })
    .onConflictDoNothing();
}

/** Upsert a customer from a customer.* payload (full update) or just ensure the row exists. */
export async function upsertCustomer(c: { id: string; email?: string | null; name?: string | null; status?: string | null; updatedAt?: string | null }) {
  if (!c.id) return;
  const values = {
    id: c.id,
    email: c.email ?? null,
    name: c.name ?? null,
    status: c.status ?? null,
    paddleUpdatedAt: toDate(c.updatedAt),
  };
  await db
    .insert(customers)
    .values(values)
    .onConflictDoUpdate({
      target: customers.id,
      set: {
        email: sql`coalesce(excluded.email, ${customers.email})`,
        name: sql`coalesce(excluded.name, ${customers.name})`,
        status: sql`coalesce(excluded.status, ${customers.status})`,
        paddleUpdatedAt: sql`coalesce(excluded.paddle_updated_at, ${customers.paddleUpdatedAt})`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Upsert a subscription from a subscription.* payload. Only applies if this event is at least as new
 * as the last one applied, so retried or out-of-order deliveries can't roll state back.
 * Returns true if the row was written.
 */
export async function upsertSubscription(sub: any, occurredAt: string | undefined): Promise<boolean> {
  const eventAt = toDate(occurredAt) || new Date();
  const firstItem = Array.isArray(sub.items) ? sub.items[0] : null;
  const values = {
    id: sub.id,
    customerId: sub.customer_id,
    status: sub.status,
    priceId: firstItem?.price?.id || null,
    productId: firstItem?.price?.product_id || firstItem?.product?.id || null,
    plan: planFromItems(sub.items),
    storeActivationId: normalizeStoreId(sub.custom_data?.storeActivationId || sub.custom_data?.store_activation_id),
    currentPeriodStart: toDate(sub.current_billing_period?.starts_at),
    currentPeriodEnd: toDate(sub.current_billing_period?.ends_at),
    scheduledChangeAction: sub.scheduled_change?.action || null,
    scheduledChangeEffectiveAt: toDate(sub.scheduled_change?.effective_at),
    canceledAt: toDate(sub.canceled_at),
    lastTransactionId: sub.transaction_id || null,
    lastEventAt: eventAt,
  };
  const rows = await db
    .insert(subscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: subscriptions.id,
      set: {
        customerId: values.customerId,
        status: values.status,
        priceId: values.priceId,
        productId: values.productId,
        plan: values.plan,
        storeActivationId: sql`coalesce(excluded.store_activation_id, ${subscriptions.storeActivationId})`,
        currentPeriodStart: values.currentPeriodStart,
        currentPeriodEnd: values.currentPeriodEnd,
        scheduledChangeAction: values.scheduledChangeAction,
        scheduledChangeEffectiveAt: values.scheduledChangeEffectiveAt,
        canceledAt: values.canceledAt,
        lastTransactionId: sql`coalesce(excluded.last_transaction_id, ${subscriptions.lastTransactionId})`,
        lastEventAt: values.lastEventAt,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${subscriptions.lastEventAt} is null or ${subscriptions.lastEventAt} <= excluded.last_event_at`,
    })
    .returning({ id: subscriptions.id });
  return rows.length > 0;
}

/** Link a completed transaction to its subscription row, if that row already exists. */
export async function linkTransaction(subscriptionId: string, transactionId: string) {
  if (!subscriptionId || !transactionId) return;
  await db
    .update(subscriptions)
    .set({ lastTransactionId: transactionId, updatedAt: sql`now()` })
    .where(eq(subscriptions.id, subscriptionId));
}

export async function getSubscriptionById(id: string) {
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
  return rows[0] || null;
}

/** Most recently updated subscription for a store activation ID. */
export async function getSubscriptionByStore(storeId: string) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.storeActivationId, storeId))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1);
  return rows[0] || null;
}
