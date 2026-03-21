// netlify/functions/create-collection.js
//
// POST — Create a new collection in Notion Collections DB, linked to a project.
//
// Request body: { title: string, projectNotionId: string, sortOrder: number }
// Response:     { notionId: string, title: string }

const { notion, DB } = require("./_shared/notion-client");
const { collectionToNotionProperties, jsonResponse } = require("./_shared/transformers");

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

  const { title, projectNotionId, sortOrder = 0 } = body;
  if (!title)            return jsonResponse(400, { error: "title is required" });
  if (!projectNotionId)  return jsonResponse(400, { error: "projectNotionId is required" });

  try {
    const properties = collectionToNotionProperties({
      title,
      sortOrder,
      status: "Not Started",
    });

    // Add project relation
    properties.Project = { relation: [{ id: projectNotionId }] };

    const page = await notion.pages.create({
      parent: { database_id: DB.collections },
      properties,
    });

    return jsonResponse(200, { notionId: page.id, title });

  } catch (err) {
    console.error("[create-collection] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
