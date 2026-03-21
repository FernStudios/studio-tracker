// netlify/functions/update-task.js
//
// PATCH — Check or uncheck a task. High-frequency call — fires on every checkbox.
// App should debounce: batch updates after a short pause (300–500ms) rather
// than one API call per rapid successive click.
//
// Request body: { notionId: string, done: boolean, completedAt: string|null }
// Response:     { ok: true }

const { notion } = require("./_shared/notion-client");
const { jsonResponse } = require("./_shared/transformers");

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

  const { notionId, done, completedAt } = body;
  if (!notionId)    return jsonResponse(400, { error: "notionId is required" });
  if (done === undefined) return jsonResponse(400, { error: "done is required" });

  try {
    await notion.pages.update({
      page_id: notionId,
      properties: {
        Done:           { checkbox: done },
        "Completed At": { date: completedAt ? { start: completedAt } : null },
      },
    });

    return jsonResponse(200, { ok: true });

  } catch (err) {
    console.error("[update-task] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
