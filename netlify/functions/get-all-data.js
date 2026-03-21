// netlify/functions/get-all-data.js
//
// GET — Called once on app load.
// Queries projects, collections, and items in parallel, then fetches tasks
// in parallel batches (10 items at a time) to stay well under the 10s limit.
//
// Response: { projects: [...], standalone: [...], customTemplates: {} }
//
// customTemplates intentionally returns {} — they live in localStorage only.
// perf.logs intentionally returns [] — perf data is loaded on demand, not on init.

const { notion, DB, queryAll } = require("./_shared/notion-client");
const {
  notionPageToProject,
  notionPageToCollection,
  notionPageToItem,
  notionPageToTask,
  reconstructStages,
  jsonResponse,
} = require("./_shared/transformers");

const PROJECT_STATUS_ORDER = { Active: 0, "In Progress": 1, "On Hold": 2, Complete: 3, Archived: 4 };
const EDITION_ORDER = { His: 0, Hers: 1, Ours: 2, None: 3 };

// Fetch all tasks for a single item using a filtered query.
// Much faster than queryAll(tasks) because it only returns rows for one item.
async function getTasksForItem(itemNotionId) {
  const results = [];
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: DB.tasks,
      filter: {
        property: "Item",
        relation: { contains: itemNotionId },
      },
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

// Fetch tasks for multiple items in parallel.
// Runs in batches of BATCH_SIZE to avoid hammering the Notion API.
async function getTasksForItems(itemNotionIds, batchSize = 10) {
  const allTaskPages = [];

  for (let i = 0; i < itemNotionIds.length; i += batchSize) {
    const batch = itemNotionIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(id => getTasksForItem(id)));
    for (const pages of batchResults) {
      allTaskPages.push(...pages);
    }
  }

  return allTaskPages;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    // -------------------------------------------------------------------------
    // 1. Fetch projects, collections, and items in parallel.
    //    These are small datasets — fast.
    // -------------------------------------------------------------------------
    const [projectPages, collectionPages, itemPages] = await Promise.all([
      queryAll(DB.projects),
      queryAll(DB.collections),
      queryAll(DB.items),
    ]);

    // -------------------------------------------------------------------------
    // 2. Transform and filter archived pages.
    // -------------------------------------------------------------------------
    const projects    = projectPages   .filter(p => !p.archived).map(notionPageToProject);
    const collections = collectionPages.filter(p => !p.archived).map(notionPageToCollection);
    const items       = itemPages      .filter(p => !p.archived).map(notionPageToItem);

    // -------------------------------------------------------------------------
    // 3. Fetch tasks for all items in parallel batches of 10.
    //    This replaces the single queryAll(DB.tasks) which fetched every row
    //    sequentially and regularly hit the 30s timeout.
    // -------------------------------------------------------------------------
    const itemNotionIds = items.map(i => i.notionId).filter(Boolean);
    const taskPages = await getTasksForItems(itemNotionIds, 10);
    const tasks = taskPages.filter(p => !p.archived).map(notionPageToTask);

    // -------------------------------------------------------------------------
    // 4. Build lookup maps for O(1) parent resolution.
    // -------------------------------------------------------------------------
    const projectMap    = new Map(projects   .map(p => [p.notionId, p]));
    const collectionMap = new Map(collections.map(c => [c.notionId, c]));

    // -------------------------------------------------------------------------
    // 5. Group tasks by item.
    // -------------------------------------------------------------------------
    const tasksByItem = new Map();
    for (const task of tasks) {
      if (!task.itemNotionId) continue;
      if (!tasksByItem.has(task.itemNotionId)) tasksByItem.set(task.itemNotionId, []);
      tasksByItem.get(task.itemNotionId).push(task);
    }

    // -------------------------------------------------------------------------
    // 6. Attach stages to items and route each item to its parent container.
    // -------------------------------------------------------------------------
    const standaloneItems = [];

    for (const item of items) {
      const itemTasks = tasksByItem.get(item.notionId) ?? [];
      item.stages = reconstructStages(itemTasks);

      if (item.currentStage && item.stages.length > 0) {
        const idx = item.stages.findIndex(s => s.name === item.currentStage);
        item.activeStage = idx >= 0 ? idx : 0;
      }

      if (item.collectionNotionId && collectionMap.has(item.collectionNotionId)) {
        collectionMap.get(item.collectionNotionId).items.push(item);
      } else if (item.projectNotionId && projectMap.has(item.projectNotionId)) {
        projectMap.get(item.projectNotionId).items.push(item);
      } else {
        standaloneItems.push(item);
      }
    }

    // -------------------------------------------------------------------------
    // 7. Sort items within collections.
    // -------------------------------------------------------------------------
    for (const collection of collections) {
      collection.items.sort((a, b) => {
        if (a.monthNumber !== null && b.monthNumber !== null) {
          if (a.monthNumber !== b.monthNumber) return a.monthNumber - b.monthNumber;
          const ea = EDITION_ORDER[a.edition] ?? 99;
          const eb = EDITION_ORDER[b.edition] ?? 99;
          return ea - eb;
        }
        return a.title.localeCompare(b.title);
      });
    }

    // -------------------------------------------------------------------------
    // 8. Attach collections to projects, sort by sortOrder.
    // -------------------------------------------------------------------------
    for (const collection of collections) {
      if (collection.projectNotionId && projectMap.has(collection.projectNotionId)) {
        projectMap.get(collection.projectNotionId).collections.push(collection);
      }
    }

    for (const project of projects) {
      project.collections.sort((a, b) => a.sortOrder - b.sortOrder);
    }

    // -------------------------------------------------------------------------
    // 9. Sort projects: Active first, then by title.
    // -------------------------------------------------------------------------
    projects.sort((a, b) => {
      const sa = PROJECT_STATUS_ORDER[a.status] ?? 99;
      const sb = PROJECT_STATUS_ORDER[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      return a.title.localeCompare(b.title);
    });

    // -------------------------------------------------------------------------
    // 10. Return the assembled tree.
    // -------------------------------------------------------------------------
    return jsonResponse(200, {
      projects,
      standalone: standaloneItems,
      customTemplates: {},
    });

  } catch (err) {
    console.error("[get-all-data] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal server error" });
  }
};
