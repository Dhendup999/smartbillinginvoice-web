/**
 * Public Paddle.js configuration for the website.
 * Endpoint: /.netlify/functions/paddle-config
 *
 * Returns only browser-safe values: the client-side token (live_...) and price IDs.
 * The client-side token is read from PADDLE_CLIENT_TOKEN so it is never hard-coded.
 */

const { IS_SANDBOX, MONTHLY_PRICE_ID, YEARLY_PRICE_ID, getClientToken } = require("../lib/paddle");

exports.handler = async function () {
  // PLACEHOLDER until PADDLE_CLIENT_TOKEN holds a real live_ token: an empty token makes the site
  // show the static USD fallback prices and a "Checkout unavailable" message instead of opening Paddle.
  const clientToken = getClientToken();
  if (!clientToken) console.warn("PADDLE_CLIENT_TOKEN missing or not a live_ client-side token; checkout disabled.");
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300"
    },
    body: JSON.stringify({
      environment: IS_SANDBOX ? "sandbox" : "production",
      configured: Boolean(clientToken),
      clientToken,
      monthlyPriceId: MONTHLY_PRICE_ID,
      yearlyPriceId: YEARLY_PRICE_ID
    })
  };
};
