// netlify/functions/log-performance.js
//
// POST — Create a new Performance Log entry and update the parent item's
// cumulative stats in one atomic-ish operation (two Notion API calls).
//
// Request body:
// {
//   itemNotionId:      string,
//   itemTitle:         string,     // used to auto-generate the log entry Title
//   itemType:          string,     // "kdp" | "etsy" | "app"
//   logDate:           string,     // ISO date e.g. "2026-03-21"
//   unitsPeriod:       number,
//   revenuePeriod:     number,
//   cumulativeUnits:   number,
//   cumulativeRevenue: number,
//   views:             number,
//   orders:            number,
//   reviewsCount:      number,
//   avgRating:         number,
//   adSpend:           number,
//   adRevenue:         number,
//   bsrOverall?:       number,
//   categoryRank1?:    string,
//   categoryRank2?:    string,
//   importSource:      "Manual" | "Etsy API" | "KDP CSV Import",
//   notes:             string
// }
//
// Response: { notionId: string, ok: true }

const { notion, DB } = require("./_shared/notion-client");
const { perfLogToNotionProperties, itemToNotionProperties, jsonResponse } = require("./_shared/transformers");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const { itemNotionId, ...logFields } = body;
  if (!itemNotionId) return jsonResponse(400, { error: "itemNotionId is required" });
  if (!logFields.logDate) return jsonResponse(400, { error: "logDate is required" });

  try {
    // -------------------------------------------------------------------------
    // 1. Build perf log properties and add the Item relation
    // -------------------------------------------------------------------------
    const logProps = perfLogToNotionProperties(logFields);
    logProps.Item = { relation: [{ id: itemNotionId }] };

    // -------------------------------------------------------------------------
    // 2. Create the Performance Log row
    // -------------------------------------------------------------------------
    const logPage = await notion.pages.create({
      parent: { database_id: DB.perf },
      properties: logProps,
    });

    // -------------------------------------------------------------------------
    // 3. Update item's cumulative stats + last updated date
    // -------------------------------------------------------------------------
    const itemUpdateProps = itemToNotionProperties({
      cumulativeRevenue: logFields.cumulativeRevenue ?? 0,
      cumulativeUnits:   logFields.cumulativeUnits   ?? 0,
      avgRating:         logFields.avgRating         ?? 0,
      reviewsCount:      logFields.reviewsCount      ?? 0,
      lastUpdated:       logFields.logDate,
      // Update KDP rank fields if provided
      ...(logFields.bsrOverall    !== undefined && { bsrOverall:    logFields.bsrOverall    }),
      ...(logFields.categoryRank1 !== undefined && { categoryRank1: logFields.categoryRank1 }),
      ...(logFields.categoryRank2 !== undefined && { categoryRank2: logFields.categoryRank2 }),
    });

    await notion.pages.update({
      page_id: itemNotionId,
      properties: itemUpdateProps,
    });

    return jsonResponse(200, { ok: true, notionId: logPage.id });

  } catch (err) {
    console.error("[log-performance] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
