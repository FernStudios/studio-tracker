// netlify/functions/update-item.js
//
// PATCH — Update any subset of an item's fields in Notion.
// Called when: stage advances, task completion changes status/progress,
// KDP/Etsy fields are saved, or perf totals are updated after a log entry.
//
// The app derives status and progressPct client-side and passes them in —
// this function does NOT recalculate them.
//
// Request body: { notionId: string, ...any optional item fields }
// Response:     { ok: true }

const { notion } = require("./_shared/notion-client");
const { itemToNotionProperties, jsonResponse } = require("./_shared/transformers");

exports.handler = async (event) => {
  if (event.httpMethod !== "PATCH") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const { notionId, ...fields } = body;
  if (!notionId) return jsonResponse(400, { error: "notionId is required" });

  // Must have at least one field to update
  if (Object.keys(fields).length === 0) {
    return jsonResponse(400, { error: "No fields provided to update" });
  }

  try {
    const properties = itemToNotionProperties(fields);

    if (Object.keys(properties).length === 0) {
      return jsonResponse(400, { error: "No recognized fields provided" });
    }

    await notion.pages.update({
      page_id: notionId,
      properties,
    });

    return jsonResponse(200, { ok: true });

  } catch (err) {
    console.error("[update-item] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
