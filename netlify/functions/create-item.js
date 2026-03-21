// netlify/functions/create-item.js
//
// POST — Create a new item in Items DB AND all its initial task rows in Tasks DB.
// Tasks are created in small batches with a delay to stay within Notion rate limits.

const { notion, DB } = require("./_shared/notion-client");
const { itemToNotionProperties, taskToNotionProperties, jsonResponse } = require("./_shared/transformers");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    // 1. Derive initial stage name
    const firstStageName = stages.length > 0 ? stages[0].name : "Concept";

    // 2. Build item properties
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

    itemProps.Project = { relation: [{ id: projectNotionId }] };
    if (collectionNotionId) {
      itemProps.Collection = { relation: [{ id: collectionNotionId }] };
    }

    // 3. Create the item page
    const itemPage = await notion.pages.create({
      parent: { database_id: DB.items },
      properties: itemProps,
    });
    const itemNotionId = itemPage.id;

    // 4. Flatten all tasks
    const taskCreateJobs = [];
    for (let si = 0; si < stages.length; si++) {
      const stage = stages[si];
      for (let ti = 0; ti < stage.tasks.length; ti++) {
        taskCreateJobs.push({ si, ti, text: stage.tasks[ti].text });
      }
    }

    // 5. Create tasks in batches of 5 with a 300ms pause between batches
    //    Keeps us well inside Notion's 3 req/s average rate limit
    const taskMeta = [];
    const BATCH = 5;
    const DELAY_MS = 300;

    for (let i = 0; i < taskCreateJobs.length; i += BATCH) {
      if (i > 0) await sleep(DELAY_MS);
      const batch = taskCreateJobs.slice(i, i + BATCH);
      const created = await Promise.all(
        batch.map(({ si, ti, text }) => {
          const taskProps = taskToNotionProperties({
            text,
            done:       false,
            stageName:  stages[si].name,
            stageOrder: si,
            taskOrder:  ti,
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
