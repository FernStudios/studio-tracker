// netlify/functions/create-item.js
//
// POST — Create a new item in Items DB AND all its initial task rows in Tasks DB.
//
// Request body:
// {
//   title: string,
//   type: string,             // "kdp" | "etsy" | "app"
//   etype: string,            // Etsy product type (if type=etsy)
//   edition: string,          // "His" | "Hers" | "Ours" | "None" | ""
//   projectNotionId: string,
//   collectionNotionId: string | null,
//   monthName: string,        // KDP only
//   monthNumber: number,      // KDP only
//   stages: [
//     {
//       name: string,
//       tasks: [{ text: string }]
//     }
//   ]
// }
//
// Response:
// {
//   notionId: string,
//   tasks: [{ text, stageIndex, taskIndex, notionId }]
// }

const { notion, DB } = require("./_shared/notion-client");
const { itemToNotionProperties, taskToNotionProperties, jsonResponse } = require("./_shared/transformers");

// Capitalize first letter — Notion Select values are Title Case
function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

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
    stages = [],
  } = body;

  if (!title) return jsonResponse(400, { error: "title is required" });
  if (!projectNotionId) return jsonResponse(400, { error: "projectNotionId is required" });

  try {
    // -------------------------------------------------------------------------
    // 1. Derive initial status and current stage from the stages array.
    // -------------------------------------------------------------------------
    const firstStageName = stages.length > 0 ? stages[0].name : "Concept";

    // -------------------------------------------------------------------------
    // 2. Build item properties
    // -------------------------------------------------------------------------
    const itemProps = itemToNotionProperties({
      title,
      type,
      ...(etype    && { etype }),
      ...(edition  && { edition }),
      status:       "Not Started",
      currentStage: firstStageName,
      progressPct:  0,
      ...(monthName   && { monthName }),
      ...(monthNumber !== null && { monthNumber }),
    });

    // Add relations
    itemProps.Project = { relation: [{ id: projectNotionId }] };
    if (collectionNotionId) {
      itemProps.Collection = { relation: [{ id: collectionNotionId }] };
    }

    // -------------------------------------------------------------------------
    // 3. Create the item page in Notion
    // -------------------------------------------------------------------------
    const itemPage = await notion.pages.create({
      parent: { database_id: DB.items },
      properties: itemProps,
    });

    const itemNotionId = itemPage.id;

    // -------------------------------------------------------------------------
    // 4. Create task rows — one Notion page per task.
    //    We create them stageIndex × taskIndex, batched 10 at a time to avoid
    //    hammering the API (Notion rate limit: 3 req/sec average, bursts ok).
    // -------------------------------------------------------------------------
    const taskMeta = []; // { stageIndex, taskIndex, text, notionId }
    const taskCreateJobs = [];

    for (let si = 0; si < stages.length; si++) {
      const stage = stages[si];
      for (let ti = 0; ti < stage.tasks.length; ti++) {
        const task = stage.tasks[ti];
        taskCreateJobs.push({ si, ti, text: task.text });
      }
    }

    // Process in batches of 10
    const BATCH = 10;
    for (let i = 0; i < taskCreateJobs.length; i += BATCH) {
      const batch = taskCreateJobs.slice(i, i + BATCH);
      const created = await Promise.all(
        batch.map(({ si, ti, text }) => {
          const taskProps = taskToNotionProperties({
            text,
            done:        false,
            stageName:   stages[si].name,
            stageOrder:  si,
            taskOrder:   ti,
          });
          taskProps.Item = { relation: [{ id: itemNotionId }] };

          return notion.pages.create({
            parent: { database_id: DB.tasks },
            properties: taskProps,
          }).then(page => ({ si, ti, text, notionId: page.id }));
        })
      );
      taskMeta.push(...created);
    }

    // -------------------------------------------------------------------------
    // 5. Return item notionId + flat task map for the app to store
    // -------------------------------------------------------------------------
    return jsonResponse(200, {
      notionId: itemNotionId,
      tasks: taskMeta.map(({ text, si, ti, notionId }) => ({
        text,
        stageIndex: si,
        taskIndex:  ti,
        notionId,
      })),
    });

  } catch (err) {
    console.error("[create-item] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
