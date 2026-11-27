/**
 * Subscription access check for the POS app.
 * GET /api/access?store=RTL-XXXX-XXXX   or   GET /api/access?subscription=sub_...
 * Returns { hasAccess, plan, features, status, reason, endsAt } from the stored Paddle subscription.
 */
import type { Config } from "@netlify/functions";
import { getAccess } from "../lib/access.js";
import { getSubscriptionById, getSubscriptionByStore, normalizeStoreId } from "../lib/billing.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: CORS });

  const url = new URL(req.url);
  const subId = (url.searchParams.get("subscription") || "").trim();
  const storeParam = url.searchParams.get("store");
  const storeId = normalizeStoreId(storeParam);

  if (subId && !/^sub_[a-z0-9]{26}$/.test(subId)) {
    return new Response(JSON.stringify({ error: "Invalid subscription ID" }), { status: 400, headers: CORS });
  }
  if (!subId && !storeId) {
    return new Response(JSON.stringify({ error: "Pass ?store=RTL-XXXX-XXXX or ?subscription=sub_..." }), { status: 400, headers: CORS });
  }

  try {
    const sub = subId ? await getSubscriptionById(subId) : await getSubscriptionByStore(storeId!);
    const access = getAccess(sub);
    return new Response(JSON.stringify({ ...access, subscriptionId: sub?.id || null }), { status: 200, headers: CORS });
  } catch (err) {
    console.error("Access check failed:", err);
    return new Response(JSON.stringify({ error: "Access check failed" }), { status: 500, headers: CORS });
  }
};

export const config: Config = { path: "/api/access" };
