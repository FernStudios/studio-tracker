// netlify/functions/sync-etsy.js
//
// POST — Pull Etsy shop stats via Etsy Open API v3 and create Performance Log
// entries for matched items. Part C of the Phase 2 build.
//
// Required Netlify env vars (in addition to Notion vars):
//   ETSY_API_KEY
//   ETSY_ACCESS_TOKEN
//   ETSY_REFRESH_TOKEN
//   ETSY_SHOP_ID
//
// Auth flow:
//   - Etsy OAuth 2.0. Access token expires after 1 hour.
//   - This function refreshes the token automatically if expired.
//   - Updated tokens are written back to Netlify env vars via Netlify API.
//     Requires NETLIFY_SITE_ID + NETLIFY_ACCESS_TOKEN env vars set as well.
//   - On first setup: complete OAuth flow manually (see README), paste
//     initial access + refresh tokens into Netlify env vars.
//
// Response:
// {
//   ok: true,
//   synced: number,       // Performance Log entries created
//   updated: number,      // Item rows updated
//   unmatched: string[],  // Etsy listing titles with no matching Notion item
//   errors: string[]      // Non-fatal errors encountered during sync
// }

const { notion, DB, queryAll } = require("./_shared/notion-client");
const { perfLogToNotionProperties, itemToNotionProperties, jsonResponse } = require("./_shared/transformers");

const ETSY_BASE = "https://openapi.etsy.com/v3/application";

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function refreshEtsyToken() {
  const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     process.env.ETSY_API_KEY,
      refresh_token: process.env.ETSY_REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Etsy token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  // Write updated tokens back to Netlify env vars so next invocation uses them.
  // Requires NETLIFY_SITE_ID and NETLIFY_ACCESS_TOKEN in env.
  if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_ACCESS_TOKEN) {
    await updateNetlifyEnvVars({
      ETSY_ACCESS_TOKEN:  data.access_token,
      ETSY_REFRESH_TOKEN: data.refresh_token,
    });
  }

  return data.access_token;
}

async function updateNetlifyEnvVars(vars) {
  const siteId = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;

  const updates = Object.entries(vars).map(([key, value]) => ({
    key,
    values: [{ context: "all", value }],
  }));

  await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/env`, {
    method: "PATCH",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  });
}

// ---------------------------------------------------------------------------
// Etsy API helpers
// ---------------------------------------------------------------------------

async function etsyGet(path, accessToken) {
  const res = await fetch(`${ETSY_BASE}${path}`, {
    headers: {
      "x-api-key":     process.env.ETSY_API_KEY,
      "Authorization": `Bearer ${accessToken}`,
    },
  });

  if (res.status === 401) {
    throw { code: "TOKEN_EXPIRED" };
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Etsy API error ${res.status}: ${text}`);
  }

  return res.json();
}

// Paginate through all Etsy results (limit 100 per page)
async function etsyGetAll(path, accessToken) {
  const results = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await etsyGet(`${path}${sep}limit=${limit}&offset=${offset}`, accessToken);
    results.push(...(data.results || []));
    if (results.length >= (data.count || 0)) break;
    offset += limit;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const required = ["ETSY_API_KEY", "ETSY_ACCESS_TOKEN", "ETSY_REFRESH_TOKEN", "ETSY_SHOP_ID"];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    return jsonResponse(500, { error: `Missing env vars: ${missing.join(", ")}` });
  }

  let accessToken = process.env.ETSY_ACCESS_TOKEN;
  const shopId    = process.env.ETSY_SHOP_ID;
  const today     = new Date().toISOString().slice(0, 10);
  const errors    = [];

  try {
    // -------------------------------------------------------------------------
    // 1. Fetch Etsy listings to get listing IDs and titles
    // -------------------------------------------------------------------------
    let listings;
    try {
      listings = await etsyGetAll(`/shops/${shopId}/listings/active`, accessToken);
    } catch (err) {
      if (err.code === "TOKEN_EXPIRED") {
        accessToken = await refreshEtsyToken();
        listings = await etsyGetAll(`/shops/${shopId}/listings/active`, accessToken);
      } else {
        throw err;
      }
    }

    // -------------------------------------------------------------------------
    // 2. Fetch transactions (orders + revenue) for the past 30 days
    // -------------------------------------------------------------------------
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
    let transactions = [];
    try {
      transactions = await etsyGetAll(
        `/shops/${shopId}/transactions?min_last_modified=${thirtyDaysAgo}`,
        accessToken
      );
    } catch (err) {
      errors.push(`Transactions fetch failed: ${err.message}`);
    }

    // -------------------------------------------------------------------------
    // 3. Load all Etsy items from Notion for matching
    // -------------------------------------------------------------------------
    const notionItems = await queryAll(DB.items, {
      property: "Type",
      select: { equals: "Etsy" },
    });

    // Build lookup maps: URL → item, title → item
    const itemByUrl   = new Map();
    const itemByTitle = new Map();

    for (const page of notionItems.filter(p => !p.archived)) {
      const urlProp   = page.properties["Etsy Listing URL"]?.url;
      const titleProp = page.properties.Title?.title?.[0]?.plain_text;
      if (urlProp)   itemByUrl.set(urlProp, page);
      if (titleProp) itemByTitle.set(titleProp.toLowerCase(), page);
    }

    // -------------------------------------------------------------------------
    // 4. Aggregate transactions by listing ID
    // -------------------------------------------------------------------------
    const listingStats = new Map(); // listingId → { units, revenue, orders }
    for (const txn of transactions) {
      const lid = String(txn.listing_id);
      if (!listingStats.has(lid)) listingStats.set(lid, { units: 0, revenue: 0, orders: 0 });
      const s = listingStats.get(lid);
      s.units   += txn.quantity        || 0;
      s.revenue += parseFloat(txn.price?.amount || 0) / (txn.price?.divisor || 100) * (txn.quantity || 1);
      s.orders  += 1;
    }

    // -------------------------------------------------------------------------
    // 5. For each listing, match to a Notion item and create a perf log entry
    // -------------------------------------------------------------------------
    const unmatched = [];
    let synced  = 0;
    let updated = 0;

    // Fetch stats for each listing (views) — rate limit: 10 req/sec
    const RATE_DELAY = 150; // ms between requests to stay under 10/sec

    for (const listing of listings) {
      const lid    = String(listing.listing_id);
      const lurl   = listing.url;
      const ltitle = listing.title;

      // Match to Notion item
      const notionPage = itemByUrl.get(lurl)
        || itemByTitle.get((ltitle || "").toLowerCase());

      if (!notionPage) {
        unmatched.push(ltitle || lid);
        continue;
      }

      // Fetch listing stats (views)
      let views = 0;
      try {
        await new Promise(r => setTimeout(r, RATE_DELAY));
        const stats = await etsyGet(`/listings/${lid}/stats`, accessToken);
        views = stats.views || 0;
      } catch (err) {
        errors.push(`Stats fetch failed for listing ${lid}: ${err.message}`);
      }

      const txnStats = listingStats.get(lid) || { units: 0, revenue: 0, orders: 0 };

      // Get existing cumulative totals from Notion item
      const p = notionPage.properties;
      const prevRevenue = p["Cumulative Revenue"]?.number || 0;
      const prevUnits   = p["Cumulative Units"]?.number   || 0;

      const cumulativeRevenue = prevRevenue + txnStats.revenue;
      const cumulativeUnits   = prevUnits   + txnStats.units;

      // Create Performance Log entry
      const logProps = perfLogToNotionProperties({
        itemTitle:         ltitle,
        itemType:          "etsy",
        logDate:           today,
        unitsPeriod:       txnStats.units,
        revenuePeriod:     txnStats.revenue,
        cumulativeUnits,
        cumulativeRevenue,
        views,
        orders:            txnStats.orders,
        reviewsCount:      listing.num_favorers || 0,
        avgRating:         0, // Etsy API doesn't expose per-listing rating in v3 base
        adSpend:           0,
        adRevenue:         0,
        importSource:      "Etsy API",
        notes:             `Auto-synced ${today}`,
      });
      logProps.Item = { relation: [{ id: notionPage.id }] };

      try {
        await notion.pages.create({ parent: { database_id: DB.perf }, properties: logProps });
        synced++;
      } catch (err) {
        errors.push(`Perf log create failed for ${ltitle}: ${err.message}`);
        continue;
      }

      // Update item cumulative totals
      try {
        await notion.pages.update({
          page_id: notionPage.id,
          properties: itemToNotionProperties({
            cumulativeRevenue,
            cumulativeUnits,
            lastUpdated: today,
          }),
        });
        updated++;
      } catch (err) {
        errors.push(`Item update failed for ${ltitle}: ${err.message}`);
      }
    }

    return jsonResponse(200, { ok: true, synced, updated, unmatched, errors });

  } catch (err) {
    console.error("[sync-etsy] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
