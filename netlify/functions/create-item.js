// netlify/functions/create-item.js
//
// POST — Create a new item in the Notion Items DB.
// Tasks are managed in app state only and synced via create-tasks.
//
// Request body:
// {
//   title: string,
//   type: string,             // "kdp" | "etsy" | "app"
//   etype: string,
//   edition: string,
//   projectNotionId: string,
//   collectionNotionId: string | null,
//   monthName?: string,
//   monthNumber?: number,
//   coverUrl?: string | null   // ← NEW: Cloudinary URL
// }
//
// Response: { notionId: string, title: string }

const { notion, DB } = require("./_shared/notion-client");
const { itemToNotionProperties, jsonResponse } = require("./_shared/transformers");

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

  const {
    title,
    type = "kdp",
    etype = "",
    edition = "",
    projectNotionId,
    collectionNotionId,
    monthName = "",
    monthNumber = null,
    coverUrl = null,           // ← NEW
  } = body;

  if (!title) return jsonResponse(400, { error: "title is required" });
  if (!projectNotionId) return jsonResponse(400, { error: "projectNotionId is required" });

  try {
    const itemProps = itemToNotionProperties({
      title,
      type,
      ...(etype    && { etype }),
      ...(edition  && { edition }),
      status:       "Not Started",
      currentStage: "Concept",
      progressPct:  0,
      ...(monthName              && { monthName }),
      ...(monthNumber !== null   && { monthNumber }),
      ...(coverUrl               && { coverUrl }),  // ← NEW
    });

    itemProps.Project = { relation: [{ id: projectNotionId }] };
    if (collectionNotionId) {
      itemProps.Collection = { relation: [{ id: collectionNotionId }] };
    }

    const itemPage = await notion.pages.create({
      parent: { database_id: DB.items },
      properties: itemProps,
    });

    return jsonResponse(200, { notionId: itemPage.id, title });

  } catch (err) {
    console.error("[create-item] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
