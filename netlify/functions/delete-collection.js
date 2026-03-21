// netlify/functions/delete-collection.js
//
// DELETE — Archive a collection page in Notion.
//
// The app must delete all items in the collection before calling this.
// This function archives the collection row only.
//
// Request body: { notionId: string }
// Response:     { ok: true }

const { archivePage } = require("./_shared/notion-client");
const { jsonResponse } = require("./_shared/transformers");

exports.handler = async (event) => {
  if (event.httpMethod !== "DELETE") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const { notionId } = body;
  if (!notionId) return jsonResponse(400, { error: "notionId is required" });

  try {
    await archivePage(notionId);
    return jsonResponse(200, { ok: true });

  } catch (err) {
    console.error("[delete-collection] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
