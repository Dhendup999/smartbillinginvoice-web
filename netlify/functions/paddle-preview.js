/**
 * CORS-enabled Paddle Price Preview proxy for smartretailergrocery.netlify.app
 * Endpoint: /.netlify/functions/paddle-preview?country=IN
 */
const { PADDLE_API_BASE, MONTHLY_PRICE_ID, YEARLY_PRICE_ID, getApiKey } = require("../lib/paddle");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=300"
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const country = String((event.queryStringParameters && event.queryStringParameters.country) || "US")
    .trim()
    .toUpperCase()
    .slice(0, 2);
  const apiKey = getApiKey();
  if (!apiKey) {
    return { statusCode: 503, headers: CORS_HEADERS, body: JSON.stringify({ ok: false, error: "Missing PADDLE_API_KEY" }) };
  }

  try {
    const res = await fetch(`${PADDLE_API_BASE}/pricing-preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        items: [
          { price_id: MONTHLY_PRICE_ID, quantity: 1 },
          { price_id: YEARLY_PRICE_ID, quantity: 1 }
        ],
        address: { country_code: country }
      })
    });

    if (!res.ok) {
      const txt = await res.text();
      return { statusCode: res.status, headers: CORS_HEADERS, body: JSON.stringify({ ok: false, error: txt }) };
    }

    const json = await res.json();
    const data = json && json.data ? json.data : {};
    const items = (data.details && Array.isArray(data.details.line_items)) ? data.details.line_items : [];
    const mItem = items.find(li => li.price && li.price.id === MONTHLY_PRICE_ID);
    const yItem = items.find(li => li.price && li.price.id === YEARLY_PRICE_ID);

    const parseAmount = (item) => {
      const minor = Number(item && item.totals && item.totals.subtotal ? item.totals.subtotal : 0);
      return Number((minor / 100).toFixed(2));
    };

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: true,
        countryCode: country,
        currencyCode: data.currency_code || "USD",
        monthly: mItem && mItem.formatted_totals ? mItem.formatted_totals.subtotal : "$0.99",
        yearly: yItem && yItem.formatted_totals ? yItem.formatted_totals.subtotal : "$7.99",
        monthlyNum: mItem ? parseAmount(mItem) : 0.99,
        yearlyNum: yItem ? parseAmount(yItem) : 7.99
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
