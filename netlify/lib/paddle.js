/**
 * Shared Paddle configuration for the Netlify Functions.
 * Every value comes from environment variables; nothing secret is committed.
 * See .env.example for the full list.
 */

const IS_SANDBOX = process.env.PADDLE_ENV === "sandbox";

// Server-side API base. Live (api.paddle.com) is the default.
const PADDLE_API_BASE = IS_SANDBOX ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";

// Live catalog price IDs. Override with env vars if the live IDs ever change.
const MONTHLY_PRICE_ID = process.env.PADDLE_MONTHLY_PRICE_ID || "pri_01m864f5p4rcr3aa827nrjveca";
const YEARLY_PRICE_ID = process.env.PADDLE_YEARLY_PRICE_ID || "pri_01m864kgedcyfnkdwxkq3ys3xd";

// Credential shape checks (no fallbacks: every credential must come from env vars).
// Paddle entity IDs (apikey_..., ntfset_...) are NOT secrets; these guards stop the code
// from using an ID where a key is required.
function getClientToken() {
  const v = process.env.PADDLE_CLIENT_TOKEN || "";
  return v.startsWith(IS_SANDBOX ? "test_" : "live_") ? v : "";
}
function getApiKey() {
  const v = process.env.PADDLE_API_KEY || "";
  return v.startsWith(IS_SANDBOX ? "pdl_sdbx_apikey_" : "pdl_live_apikey_") ? v : "";
}
function getWebhookSecret() {
  const v = process.env.PADDLE_WEBHOOK_SECRET || "";
  return v.startsWith("pdl_ntfset_") ? v : "";
}

module.exports = {
  IS_SANDBOX, PADDLE_API_BASE, MONTHLY_PRICE_ID, YEARLY_PRICE_ID,
  getClientToken, getApiKey, getWebhookSecret
};
