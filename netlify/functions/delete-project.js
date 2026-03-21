// netlify/functions/delete-project.js
//
// DELETE — Archive a project page in Notion.
//
// IMPORTANT: This does NOT cascade to collections or items. The app is
// responsible for calling delete-collection and delete-item first for all
// children before calling this. Notion does not hard-delete via API — archive
// is the equivalent.
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
    console.error("[delete-project] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
