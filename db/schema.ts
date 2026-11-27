import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

// One row per Paddle customer (ctm_...).
export const customers = pgTable("customers", {
  id: text().primaryKey(), // Paddle customer ID
  email: text(),
  name: text(),
  status: text(),
  paddleUpdatedAt: timestamp("paddle_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// One row per Paddle subscription (sub_...). Mirrors Paddle's state; access is derived from it.
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text().primaryKey(), // Paddle subscription ID
    customerId: text("customer_id").notNull(),
    status: text().notNull(), // active | trialing | past_due | paused | canceled
    priceId: text("price_id"),
    productId: text("product_id"),
    plan: text(), // MONTHLY | YEARLY
    storeActivationId: text("store_activation_id"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    scheduledChangeAction: text("scheduled_change_action"), // cancel | pause | resume
    scheduledChangeEffectiveAt: timestamp("scheduled_change_effective_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    lastTransactionId: text("last_transaction_id"),
    // occurred_at of the last applied event, so older events delivered late can't overwrite newer state.
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("subscriptions_customer_idx").on(t.customerId), index("subscriptions_store_idx").on(t.storeActivationId)]
);

// Processed webhook events (evt_...), for idempotency and an audit trail.
export const webhookEvents = pgTable("webhook_events", {
  id: text().primaryKey(), // Paddle event ID
  eventType: text("event_type").notNull(),
  entityId: text("entity_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
  result: text(),
});
