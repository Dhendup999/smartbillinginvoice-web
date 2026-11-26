/**
 * Smart Billing & Retail POS — Paddle Billing v2 Webhook Handler (Zero-Dependency Netlify Function)
 * Endpoint: /.netlify/functions/paddle-webhook
 *
 * Required Netlify Environment Variables (Site settings -> Environment variables):
 *   PADDLE_WEBHOOK_SECRET   = pdl_ntfset_... (from Paddle -> Developer tools -> Notifications -> Edit destination)
 *   PADDLE_API_KEY          = pdl_live_apikey_... (used to look up customer email from customer_id)
 *   RESEND_API_KEY          = re_... (from resend.com to send automatic SB4 license emails)
 *   RESEND_FROM_EMAIL       = Smart Billing <license@smartbillinginvoice.in> (or Resend verified sender)
 *   OWNER_ALERT_EMAIL       = (owner inbox for BCC + fallback alerts)
 *   SB_SEAL_DOMAIN_SALT     = (your SB4 seal domain salt — keep secret, never commit the value)
 *   SB_MASTER_PEPPER        = (paste your MASTER_PROPRIETARY_PEPPER from owner_license_generator.js)
 *
 * Optional Environment Variables:
 *   PADDLE_ENV              = leave unset for live (set "sandbox" only for local sandbox testing)
 *   PADDLE_MONTHLY_PRICE_ID / PADDLE_YEARLY_PRICE_ID = override live price IDs (defaults in netlify/lib/paddle.js)
 *
 * Security: requests are accepted only from Paddle's webhook IPs, fetched at runtime from
 * https://api.paddle.com/ips (data.ipv4_cidrs), AND must carry a valid Paddle-Signature.
 */

const crypto = require("crypto");
const { PADDLE_API_BASE, MONTHLY_PRICE_ID, YEARLY_PRICE_ID, getApiKey, getWebhookSecret } = require("../lib/paddle");

// ---- Paddle webhook IP allowlist (source of truth: GET {PADDLE_API_BASE}/ips) ----
const IP_CACHE_TTL_MS = 60 * 60 * 1000;
let ipCache = { cidrs: null, fetchedAt: 0 };

async function getPaddleWebhookCidrs() {
  const fresh = ipCache.cidrs && Date.now() - ipCache.fetchedAt < IP_CACHE_TTL_MS;
  if (fresh) return ipCache.cidrs;
  try {
    const res = await fetch(`${PADDLE_API_BASE}/ips`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const cidrs = json?.data?.ipv4_cidrs;
    if (!Array.isArray(cidrs) || cidrs.length === 0) throw new Error("no ipv4_cidrs in response");
    ipCache = { cidrs, fetchedAt: Date.now() };
  } catch (err) {
    console.error("Could not refresh Paddle IP list:", err.message);
  }
  return ipCache.cidrs; // stale list if refresh failed, null if never fetched
}

function ipv4ToInt(ip) {
  const parts = String(ip).trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

function ipInCidrs(ip, cidrs) {
  const ipStr = String(ip || "").replace(/^::ffff:/i, "");
  const ipInt = ipv4ToInt(ipStr);
  if (ipInt === null) return false;
  return cidrs.some(cidr => {
    const [base, bitsStr] = String(cidr).split("/");
    const bits = bitsStr === undefined ? 32 : Number(bitsStr);
    const baseInt = ipv4ToInt(base);
    if (baseInt === null || !(bits >= 0 && bits <= 32)) return false;
    const size = 2 ** (32 - bits);
    return Math.floor(ipInt / size) === Math.floor(baseInt / size);
  });
}

function getClientIp(headers) {
  const h = headers || {};
  return h["x-nf-client-connection-ip"] || "";
}

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function generateStoreBoundKey(storeActivationId, plan, expiryYyyyMmDd, sealSalt, masterPepper, nonce = "") {
  const cleanStoreId = String(storeActivationId || "").trim().toUpperCase();
  const normPlan = String(plan).toUpperCase() === "MONTHLY" ? "MONTHLY" : "YEARLY";
  const normExp = String(expiryYyyyMmDd).replace(/[^0-9]/g, "").slice(0, 8);
  const normNonce = (nonce
    ? String(nonce).toUpperCase().replace(/[^0-9A-F]/g, "")
    : crypto.randomBytes(2).toString("hex").toUpperCase()
  ).slice(0, 4).padEnd(4, "0");

  let digest = sha256(`SB4_KEY_GEN|${normPlan}|${normExp}|${normNonce}|${cleanStoreId}|${sealSalt}|${masterPepper}`);
  for (let i = 0; i < 2048; i++) {
    digest = sha256(`${digest}|${i}|${normNonce}|${cleanStoreId}`);
  }
  const sig = digest.slice(0, 12).toUpperCase();
  return `SB4-${normPlan}-${normExp}-${normNonce}-${sig}`;
}

function verifyPaddleSignature(rawBody, signatureHeader, webhookSecret, toleranceSec = 300) {
  if (!rawBody || !signatureHeader || !webhookSecret) return false;
  const parts = String(signatureHeader).split(";").map(s => s.trim());
  let ts = null;
  const h1List = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "ts") ts = v;
    if (k === "h1") h1List.push(v);
  }
  if (!ts || h1List.length === 0) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > toleranceSec) return false;

  const expectedHex = crypto
    .createHmac("sha256", webhookSecret)
    .update(`${ts}:${rawBody}`, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expectedHex, "utf8");
  return h1List.some(h1 => {
    const actualBuf = Buffer.from(h1, "utf8");
    return actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
  });
}

function addDaysYyyyMmDd(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function detectPlan(txData) {
  const monthlyId = MONTHLY_PRICE_ID;
  const yearlyId = YEARLY_PRICE_ID;
  const items = Array.isArray(txData?.items) ? txData.items : [];
  for (const item of items) {
    const pId = item?.price?.id || item?.price_id || "";
    const interval = item?.price?.billing_cycle?.interval || "";
    if (pId === monthlyId || interval === "month") return "MONTHLY";
    if (pId === yearlyId || interval === "year") return "YEARLY";
  }
  return "YEARLY";
}

async function fetchPaddleCustomerEmail(customerId) {
  const apiKey = getApiKey();
  if (!apiKey) {
    // FALLBACK until PADDLE_API_KEY holds a real pdl_live_apikey_ key: skip the lookup, so the
    // owner-alert email path is used when the webhook payload has no customer email.
    console.warn("PADDLE_API_KEY missing or not a live API key; skipping customer email lookup.");
    return "";
  }
  if (!customerId) return "";
  const res = await fetch(`${PADDLE_API_BASE}/customers/${encodeURIComponent(customerId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) return "";
  const json = await res.json();
  return json?.data?.email || "";
}

async function sendResendEmail({ to, bcc, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // MOCK: email delivery is disabled until RESEND_API_KEY (and RESEND_FROM_EMAIL) are set.
    // The webhook still acknowledges Paddle with 2xx; the email is only logged.
    console.warn(`[MOCK EMAIL — RESEND_API_KEY not set] Would send "${subject}" to ${[].concat(to).join(", ")}`);
    return { mocked: true };
  }
  const from = process.env.RESEND_FROM_EMAIL || "Smart Billing <onboarding@resend.dev>";
  const payload = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (bcc) payload.bcc = Array.isArray(bcc) ? bcc : [bcc];

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend API error ${res.status}: ${errText}`);
  }
  return res.json();
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const cidrs = await getPaddleWebhookCidrs();
  if (!cidrs) {
    // Could not load the allowlist at all: fail closed with a retryable status so Paddle redelivers.
    return { statusCode: 503, body: JSON.stringify({ error: "Allowlist unavailable" }) };
  }
  const clientIp = getClientIp(event.headers);
  if (!ipInCidrs(clientIp, cidrs)) {
    console.warn(`Rejected webhook from non-Paddle IP: ${clientIp || "unknown"}`);
    return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  const sigHeader = event.headers["paddle-signature"] || event.headers["Paddle-Signature"] || "";
  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) {
    console.error("PADDLE_WEBHOOK_SECRET missing or not a pdl_ntfset_ signing secret; rejecting webhook.");
  }

  if (!verifyPaddleSignature(rawBody, sigHeader, webhookSecret)) {
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid Paddle-Signature" }) };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  console.log(`Paddle webhook received: ${payload.event_type} (${payload.data?.id || "no id"})`);

  if (payload.event_type !== "transaction.completed") {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, ignored: payload.event_type || "unknown" })
    };
  }

  const tx = payload.data || {};
  const txId = tx.id || "unknown";
  const plan = detectPlan(tx);
  const expiryYyyyMmDd = addDaysYyyyMmDd(plan === "MONTHLY" ? 32 : 367);
  const storeIdRaw = tx.custom_data?.storeActivationId || tx.custom_data?.store_activation_id || "";
  const storeId = String(storeIdRaw).trim().toUpperCase();
  const isValidStoreId = /^RTL-[0-9A-F]{4}-[0-9A-F]{4}$/.test(storeId);

  let customerEmail = tx.customer?.email || tx.details?.customer?.email || "";
  if (!customerEmail && tx.customer_id) {
    customerEmail = await fetchPaddleCustomerEmail(tx.customer_id);
  }

  const ownerEmail = process.env.OWNER_ALERT_EMAIL || "smartpocketledger@gmail.com";
  const sealSalt = process.env.SB_SEAL_DOMAIN_SALT || "";
  const masterPepper = process.env.SB_MASTER_PEPPER || "";

  try {
    if (isValidStoreId && sealSalt && masterPepper && customerEmail) {
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
        `
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, issued: true, storeId, plan }) };
    } else {
      await sendResendEmail({
        to: ownerEmail,
        subject: `[Action Needed] Paddle Payment Completed (${txId})`,
        html: `
          <h3>Paddle Payment Received</h3>
          <p><strong>Transaction ID:</strong> ${txId}<br/>
          <strong>Plan:</strong> ${plan}<br/>
          <strong>Customer Email:</strong> ${customerEmail || "Not provided (check Paddle dashboard)"}<br/>
          <strong>Store Activation ID:</strong> ${storeId || "Not entered at checkout"}</p>
          <p>Generate the SB4 key in your Owner License Generator once you have the Store Activation ID.</p>
        `
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, issued: false, fallbackAlertSent: true }) };
    }
  } catch (err) {
    console.error("Webhook fulfillment error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

exports._test = { generateStoreBoundKey, verifyPaddleSignature, detectPlan, ipInCidrs };
