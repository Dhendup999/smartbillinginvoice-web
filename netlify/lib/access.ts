/**
 * Access helper: decides what a subscription unlocks.
 * Pure function over a subscription row, so the webhook, the /api/access endpoint and tests
 * all use the same rule.
 */

export type Plan = "MONTHLY" | "YEARLY";

export const PLAN_FEATURES: Record<Plan, string[]> = {
  MONTHLY: ["pro_license", "e_invoice_irn", "renewal_grace"],
  YEARLY: ["pro_license", "e_invoice_irn", "renewal_grace", "encrypted_vault_sync", "priority_tax_updates"],
};

// Paddle statuses that keep access. past_due keeps access while Paddle retries payment
// (the plan's renewal grace period); paused and canceled lose it.
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);

export interface SubscriptionLike {
  status: string;
  plan: string | null;
  scheduledChangeAction?: string | null;
  scheduledChangeEffectiveAt?: Date | string | null;
}

export interface AccessResult {
  hasAccess: boolean;
  plan: Plan | null;
  features: string[];
  status: string;
  reason: string;
  endsAt: string | null; // set when a cancellation or pause is scheduled
}

export function getAccess(sub: SubscriptionLike | null | undefined): AccessResult {
  if (!sub) {
    return { hasAccess: false, plan: null, features: [], status: "none", reason: "no_subscription", endsAt: null };
  }
  const plan: Plan | null = sub.plan === "MONTHLY" || sub.plan === "YEARLY" ? sub.plan : null;
  const scheduledEnd =
    sub.scheduledChangeAction === "cancel" || sub.scheduledChangeAction === "pause"
      ? sub.scheduledChangeEffectiveAt
        ? new Date(sub.scheduledChangeEffectiveAt).toISOString()
        : null
      : null;

  if (!ENTITLED_STATUSES.has(sub.status)) {
    return { hasAccess: false, plan, features: [], status: sub.status, reason: `status_${sub.status}`, endsAt: null };
  }
  if (!plan) {
    return { hasAccess: false, plan: null, features: [], status: sub.status, reason: "unknown_plan", endsAt: scheduledEnd };
  }
  return {
    hasAccess: true,
    plan,
    features: PLAN_FEATURES[plan],
    status: sub.status,
    reason: scheduledEnd ? `${sub.scheduledChangeAction}_scheduled` : "entitled",
    endsAt: scheduledEnd,
  };
}
