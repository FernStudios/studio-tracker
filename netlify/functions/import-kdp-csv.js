// netlify/functions/import-kdp-csv.js
//
// POST — Accept a KDP royalties report CSV (multipart/form-data or base64 JSON),
// parse it, match rows to Notion Items by ASIN or title, and bulk-create
// Performance Log entries.
//
// KDP CSV columns (KDP Royalties report):
//   Title, Author, ASIN, Marketplace, Units Sold, Units Returned, Net Units Sold,
//   Royalties (Currency), Royalties Earned
//
// Two accepted request formats:
//   1. JSON: { csv: "<base64-encoded CSV content>", reportDate: "2026-03" }
//   2. Form data with file field "csv" — handled via raw body parse
//
// Response:
// {
//   ok: true,
//   matched:   number,    // rows successfully imported
//   unmatched: number,    // rows with no matching Notion item
//   created:   number,    // Performance Log entries created
//   unmatchedTitles: string[]
// }

const { parse }  = require("csv-parse/sync");
const { notion, DB, queryAll } = require("./_shared/notion-client");
const { perfLogToNotionProperties, itemToNotionProperties, jsonResponse } = require("./_shared/transformers");

// ---------------------------------------------------------------------------
// KDP CSV column normalizer
// KDP has changed column names across report versions — handle both
// ---------------------------------------------------------------------------
function getCol(row, ...candidates) {
  for (const key of candidates) {
    const found = Object.keys(row).find(k => k.trim().toLowerCase() === key.toLowerCase());
    if (found && row[found] !== undefined && row[found] !== "") return row[found];
  }
  return null;
}

function parseFloat2(val) {
  if (val === null || val === undefined) return 0;
  const n = parseFloat(String(val).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function parseInt2(val) {
  if (val === null || val === undefined) return 0;
  const n = parseInt(String(val).replace(/[^0-9\-]/g, ""), 10);
  return isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// Extract CSV content from request body
// ---------------------------------------------------------------------------
function extractCsvContent(event) {
  const ct = event.headers["content-type"] || "";

  if (ct.includes("application/json")) {
    const body = JSON.parse(event.body);
    if (!body.csv) throw new Error("No csv field in JSON body");
    // Accept both raw text and base64
    try {
      return Buffer.from(body.csv, "base64").toString("utf8");
    } catch {
      return body.csv;
    }
  }

  // For multipart/form-data: body arrives as base64 in Netlify functions
  if (ct.includes("multipart/form-data")) {
    if (event.isBase64Encoded) {
      const raw = Buffer.from(event.body, "base64").toString("binary");
      const boundary = ct.split("boundary=")[1];
      if (!boundary) throw new Error("No multipart boundary found");
      const parts = raw.split(`--${boundary}`);
      for (const part of parts) {
        if (part.includes('name="csv"') || part.includes("name='csv'") || part.includes(".csv")) {
          const headerEnd = part.indexOf("\r\n\r\n");
          if (headerEnd !== -1) return part.slice(headerEnd + 4).replace(/\r\n--$/, "").trim();
        }
      }
      throw new Error("No csv file part found in multipart body");
    }
  }

  // Fallback: treat raw body as CSV text
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  // Parse reportDate from query string if provided (?reportDate=2026-03)
  const reportDate = event.queryStringParameters?.reportDate
    || new Date().toISOString().slice(0, 10);

  let csvText;
  try {
    csvText = extractCsvContent(event);
  } catch (err) {
    return jsonResponse(400, { error: `Could not extract CSV: ${err.message}` });
  }

  // -------------------------------------------------------------------------
  // 1. Parse CSV
  // -------------------------------------------------------------------------
  let rows;
  try {
    rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,    // KDP CSVs sometimes have BOM
    });
  } catch (err) {
    return jsonResponse(400, { error: `CSV parse failed: ${err.message}` });
  }

  if (!rows || rows.length === 0) {
    return jsonResponse(400, { error: "CSV contains no data rows" });
  }

  // -------------------------------------------------------------------------
  // 2. Load KDP items from Notion for matching
  // -------------------------------------------------------------------------
  const notionItems = await queryAll(DB.items, {
    property: "Type",
    select: { equals: "KDP" },
  });

  // Build lookup: ASIN → page, title (lowercase) → page
  const itemByAsin  = new Map();
  const itemByTitle = new Map();

  for (const page of notionItems.filter(p => !p.archived)) {
    const asin  = page.properties.ASIN?.rich_text?.[0]?.plain_text?.trim();
    const title = page.properties.Title?.title?.[0]?.plain_text?.trim();
    if (asin)  itemByAsin.set(asin.toUpperCase(), page);
    if (title) itemByTitle.set(title.toLowerCase(), page);
  }

  // -------------------------------------------------------------------------
  // 3. Process rows — match, aggregate by ASIN (in case of multiple rows per title)
  // -------------------------------------------------------------------------
  const aggByAsin  = new Map(); // ASIN or title-key → aggregated stats
  const unmatchedTitles = [];

  for (const row of rows) {
    const asin   = (getCol(row, "ASIN") || "").trim().toUpperCase();
    const title  = (getCol(row, "Title") || "").trim();
    const units  = parseInt2(getCol(row, "Net Units Sold", "Units Sold"));
    const royalty= parseFloat2(getCol(row, "Royalties Earned", "Royalties (Currency)"));

    const notionPage = (asin && itemByAsin.get(asin))
      || itemByTitle.get(title.toLowerCase());

    if (!notionPage) {
      if (title && !unmatchedTitles.includes(title)) unmatchedTitles.push(title);
      continue;
    }

    const key = notionPage.id;
    if (!aggByAsin.has(key)) {
      aggByAsin.set(key, { notionPage, title, units: 0, royalty: 0 });
    }
    const agg = aggByAsin.get(key);
    agg.units   += units;
    agg.royalty += royalty;
  }

  // -------------------------------------------------------------------------
  // 4. Create Performance Log entries for matched items, update item totals
  // -------------------------------------------------------------------------
  let created = 0;
  const BATCH = 5;
  const entries = Array.from(aggByAsin.values());

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);

    await Promise.all(batch.map(async ({ notionPage, title, units, royalty }) => {
      const p = notionPage.properties;
      const prevRevenue = p["Cumulative Revenue"]?.number || 0;
      const prevUnits   = p["Cumulative Units"]?.number   || 0;
      const cumulativeRevenue = prevRevenue + royalty;
      const cumulativeUnits   = prevUnits   + units;

      const logProps = perfLogToNotionProperties({
        itemTitle:         title,
        itemType:          "kdp",
        logDate:           reportDate,
        unitsPeriod:       units,
        revenuePeriod:     royalty,
        cumulativeUnits,
        cumulativeRevenue,
        views:             0,
        orders:            units,  // KDP: units = orders
        reviewsCount:      0,
        avgRating:         0,
        adSpend:           0,
        adRevenue:         0,
        importSource:      "KDP CSV Import",
        notes:             `KDP CSV import — report period: ${reportDate}`,
      });
      logProps.Item = { relation: [{ id: notionPage.id }] };

      await notion.pages.create({ parent: { database_id: DB.perf }, properties: logProps });

      await notion.pages.update({
        page_id: notionPage.id,
        properties: itemToNotionProperties({
          cumulativeRevenue,
          cumulativeUnits,
          lastUpdated: reportDate,
        }),
      });

      created++;
    }));
  }

  return jsonResponse(200, {
    ok:              true,
    matched:         entries.length,
    unmatched:       unmatchedTitles.length,
    created,
    unmatchedTitles,
  });
};
