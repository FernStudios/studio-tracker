// netlify/functions/create-project.js
//
// POST — Create a new project in Notion Projects DB.
//
// Request body: { title: string, desc: string }
// Response:     { notionId: string, title: string }

const { notion, DB } = require("./_shared/notion-client");
const { projectToNotionProperties, jsonResponse } = require("./_shared/transformers");

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

  const { title, desc = "" } = body;
  if (!title) return jsonResponse(400, { error: "title is required" });

  try {
    const page = await notion.pages.create({
      parent: { database_id: DB.projects },
      properties: projectToNotionProperties({ title, desc, status: "Active" }),
    });

    return jsonResponse(200, { notionId: page.id, title });

  } catch (err) {
    console.error("[create-project] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
