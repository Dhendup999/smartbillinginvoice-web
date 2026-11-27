/**
 * Smart Billing & Retail POS — Paddle Billing webhook handler.
 * Endpoint: /.netlify/functions/paddle-webhook (unchanged, so the Paddle notification destination keeps working)
 *
 * - Accepts requests only from Paddle's webhook IPs AND with a valid Paddle-Signature.
 * - customer.*      -> upserts the customers table
 * - subscription.*  -> upserts the subscriptions table (status, plan, billing period, scheduled change)
 * - transaction.completed -> links the transaction to its subscription and emails the SB4 license key
 * - Each event ID is recorded once, so Paddle retries never send a second license email.
 *
 * Env vars: PADDLE_WEBHOOK_SECRET, PADDLE_API_KEY, RESEND_API_KEY, RESEND_FROM_EMAIL,
 * OWNER_ALERT_EMAIL, SB_SEAL_DOMAIN_SALT, SB_MASTER_PEPPER (see .env.example).
 */
import type { Context } from "@netlify/functions";
import { getWebhookSecret } from "../lib/paddle.js";
import {
  getPaddleWebhookCidrs, ipInCidrs, verifyPaddleSignature, generateStoreBoundKey,
  addDaysYyyyMmDd, detectPlan, fetchPaddleCustomerEmail, sendResendEmail,
} from "../lib/webhook-utils.js";
import {
  isEventProcessed, recordEvent, upsertCustomer, upsertSubscription, linkTransaction, normalizeStoreId,
} from "../lib/billing.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function handleTransactionCompleted(tx: any) {
  const txId = tx.id || "unknown";
  if (tx.customer_id) await upsertCustomer({ id: tx.customer_id });
  if (tx.subscription_id) await linkTransaction(tx.subscription_id, txId);

  const plan = detectPlan(tx);
  const expiryYyyyMmDd = addDaysYyyyMmDd(plan === "MONTHLY" ? 32 : 367);
  const storeId = normalizeStoreId(tx.custom_data?.storeActivationId || tx.custom_data?.store_activation_id) || "";
  const rawStoreId = String(tx.custom_data?.storeActivationId || tx.custom_data?.store_activation_id || "").trim().toUpperCase();

  let customerEmail = tx.customer?.email || tx.details?.customer?.email || "";
  if (!customerEmail && tx.customer_id) customerEmail = await fetchPaddleCustomerEmail(tx.customer_id);
  if (customerEmail && tx.customer_id) await upsertCustomer({ id: tx.customer_id, email: customerEmail });

  const ownerEmail = process.env.OWNER_ALERT_EMAIL || "smartpocketledger@gmail.com";
  const sealSalt = process.env.SB_SEAL_DOMAIN_SALT || "";
  const masterPepper = process.env.SB_MASTER_PEPPER || "";

  if (storeId && sealSalt && masterPepper && customerEmail) {
    const licenseKey = generateStoreBoundKey(storeId, plan, expiryYyyyMmDd, sealSalt, masterPepper);
    await sendResendEmail({
      to: customerEmail,
      bcc: ownerEmail,
      subject: `Your Smart Billing & Retail POS Pro License Key (${storeId})`,
      html: `
        <h2>Thank you for subscribing to Smart Billing &amp; Retail POS!</h2>
        <p>Your <strong>${plan}</strong> Pro license is ready.</p>
        <p><strong>Store Activation ID:</strong> <code>${storeId}</code><br/>
        <strong>Valid Until:</strong> ${expiryYyyyMmDd}<br/>
        <strong>License Key:</strong></p>
        <pre style="padding:12px;background:#f1f5f9;border-radius:8px;font-size:16px;">${licenseKey}</pre>
        <p>Open your POS app at <a href="https://smartretailergrocery.netlify.app">smartretailergrocery.netlify.app</a>, go to <strong>Manage Subscription / Enter License Key</strong>, and paste the key above.</p>
        <p style="font-size:12px;color:#64748b;">Transaction ID: ${txId}</p>
      `,
    });
    return { issued: true, storeId, plan };
  }
  await sendResendEmail({
    to: ownerEmail,
    subject: `[Action Needed] Paddle Payment Completed (${txId})`,
    html: `
      <h3>Paddle Payment Received</h3>
      <p><strong>Transaction ID:</strong> ${txId}<br/>
      <strong>Plan:</strong> ${plan}<br/>
      <strong>Customer Email:</strong> ${customerEmail || "Not provided (check Paddle dashboard)"}<br/>
      <strong>Store Activation ID:</strong> ${rawStoreId || "Not entered at checkout"}</p>
      <p>Generate the SB4 key in your Owner License Generator once you have the Store Activation ID.</p>
    `,
  });
  return { issued: false, fallbackAlertSent: true };
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

  const cidrs = await getPaddleWebhookCidrs();
  if (!cidrs) return json(503, { error: "Allowlist unavailable" }); // retryable: Paddle redelivers
  const clientIp = context.ip || req.headers.get("x-nf-client-connection-ip") || "";
  if (!ipInCidrs(clientIp, cidrs)) {
    console.warn(`Rejected webhook from non-Paddle IP: ${clientIp || "unknown"}`);
    return json(403, { error: "Forbidden" });
  }

  const rawBody = await req.text();
  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) console.error("PADDLE_WEBHOOK_SECRET missing or not a pdl_ntfset_ signing secret; rejecting webhook.");
  if (!verifyPaddleSignature(rawBody, req.headers.get("paddle-signature") || "", webhookSecret)) {
    return json(401, { error: "Invalid Paddle-Signature" });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const eventId: string = payload.event_id || payload.notification_id || "";
  const eventType: string = payload.event_type || "unknown";
  const data = payload.data || {};
  console.log(`Paddle webhook received: ${eventType} ${eventId} (${data.id || "no id"})`);

  try {
    if (await isEventProcessed(eventId)) return json(200, { ok: true, duplicate: true });

    let result: Record<string, unknown> = { ignored: eventType };
    if (eventType.startsWith("customer.")) {
      await upsertCustomer({ id: data.id, email: data.email, name: data.name, status: data.status, updatedAt: data.updated_at });
      result = { customer: data.id };
    } else if (eventType.startsWith("subscription.")) {
      if (data.customer_id) await upsertCustomer({ id: data.customer_id });
      const applied = await upsertSubscription(data, payload.occurred_at);
      result = { subscription: data.id, status: data.status, applied };
    } else if (eventType === "transaction.completed") {
      result = await handleTransactionCompleted(data);
    }

    await recordEvent({ id: eventId, type: eventType, entityId: data.id, occurredAt: payload.occurred_at, result: JSON.stringify(result) });
    return json(200, { ok: true, ...result });
  } catch (err: any) {
    // Non-2xx makes Paddle retry; nothing was recorded, so the retry reprocesses cleanly.
    console.error(`Webhook processing error for ${eventType} ${eventId}:`, err);
    return json(500, { error: "Processing failed" });
  }
};
