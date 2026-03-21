// netlify/functions/update-project.js
//
// PATCH — Update project title, description, or status.
//
// Request body: { notionId: string, title?: string, desc?: string, status?: string }
// Response:     { ok: true }

const { notion } = require("./_shared/notion-client");
const { projectToNotionProperties, jsonResponse } = require("./_shared/transformers");

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

  try {
    const properties = projectToNotionProperties(fields);

    if (Object.keys(properties).length === 0) {
      return jsonResponse(400, { error: "No recognized fields provided" });
    }

    await notion.pages.update({ page_id: notionId, properties });
    return jsonResponse(200, { ok: true });

  } catch (err) {
    console.error("[update-project] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
