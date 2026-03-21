// netlify/functions/create-tasks.js
//
// POST — Create a batch of task rows in the Tasks DB for an existing item.
// Called from the browser in chunks of 10 after create-item returns.
// Safe to call multiple times — designed for chunked background sync.
//
// Request body:
// {
//   itemNotionId: string,
//   tasks: [
//     { text: string, stageName: string, stageOrder: number, taskOrder: number }
//   ]
// }
//
// Response: { created: number, tasks: [{ stageOrder, taskOrder, notionId }] }

const { notion, DB } = require("./_shared/notion-client");
const { taskToNotionProperties, jsonResponse } = require("./_shared/transformers");

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

  const { itemNotionId, tasks = [] } = body;
  if (!itemNotionId) return jsonResponse(400, { error: "itemNotionId is required" });
  if (!tasks.length)  return jsonResponse(200, { created: 0, tasks: [] });

  try {
    // Create all tasks in this batch in parallel — caller controls batch size (max 10)
    const results = await Promise.all(
      tasks.map(({ text, stageName, stageOrder, taskOrder }) => {
        const props = taskToNotionProperties({
          text,
          done:       false,
          stageName,
          stageOrder,
          taskOrder,
        });
        props.Item = { relation: [{ id: itemNotionId }] };
        return notion.pages.create({
          parent: { database_id: DB.tasks },
          properties: props,
        }).then(page => ({ stageOrder, taskOrder, notionId: page.id }));
      })
    );

    return jsonResponse(200, { created: results.length, tasks: results });

  } catch (err) {
    console.error("[create-tasks] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
