/**
 * Helpers for the Paddle webhook: IP allowlist, signature verification, SB4 license keys, Resend email.
 * (Moved unchanged from the original paddle-webhook function.)
 */
const crypto = require("crypto");
const { PADDLE_API_BASE, MONTHLY_PRICE_ID, YEARLY_PRICE_ID, getApiKey } = require("./paddle");

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

module.exports = {
  getPaddleWebhookCidrs, ipInCidrs, verifyPaddleSignature, generateStoreBoundKey,
  addDaysYyyyMmDd, detectPlan, fetchPaddleCustomerEmail, sendResendEmail
};
