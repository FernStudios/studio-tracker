// netlify/functions/delete-item.js
//
// DELETE — Archive an item, all its task rows, and all its Performance Log rows.
//
// Task notionIds are sent by the app (it already has them from create-item).
// Performance Log rows are queried here by Item relation rather than requiring
// the app to track perf log IDs.
//
// Request body: { notionId: string, taskNotionIds: string[] }
// Response:     { ok: true, archivedTasks: number, archivedPerfLogs: number }

const { notion, DB, queryAll, archivePage, archivePages } = require("./_shared/notion-client");
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

  const { notionId, taskNotionIds = [] } = body;
  if (!notionId) return jsonResponse(400, { error: "notionId is required" });

  try {
    // -------------------------------------------------------------------------
    // 1. Archive all task rows (app provided the IDs — no query needed).
    // -------------------------------------------------------------------------
    if (taskNotionIds.length > 0) {
      await archivePages(taskNotionIds);
    }

    // -------------------------------------------------------------------------
    // 2. Query Performance Log for rows referencing this item, then archive all.
    // -------------------------------------------------------------------------
    const perfPages = await queryAll(DB.perf, {
      property: "Item",
      relation: { contains: notionId },
    });

    const perfIds = perfPages.filter(p => !p.archived).map(p => p.id);
    if (perfIds.length > 0) {
      await archivePages(perfIds);
    }

    // -------------------------------------------------------------------------
    // 3. Archive the item page itself.
    // -------------------------------------------------------------------------
    await archivePage(notionId);

    return jsonResponse(200, {
      ok: true,
      archivedTasks:    taskNotionIds.length,
      archivedPerfLogs: perfIds.length,
    });

  } catch (err) {
    console.error("[delete-item] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
