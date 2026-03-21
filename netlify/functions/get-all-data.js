// netlify/functions/get-all-data.js
//
// GET — Called once on app load.
// Queries all 4 databases in parallel, assembles the full nested data tree,
// and returns it in the format the app expects (matches localStorage DB shape).
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

// Status sort order for projects (Active surfaces first)
const PROJECT_STATUS_ORDER = { Active: 0, "In Progress": 1, "On Hold": 2, Complete: 3, Archived: 4 };

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    // -------------------------------------------------------------------------
    // 1. Fetch all 4 databases in parallel.
    //    Tasks are filtered to non-archived only via the Notion filter — avoids
    //    pulling ghost rows left by incomplete deletes.
    // -------------------------------------------------------------------------
    const [projectPages, collectionPages, itemPages, taskPages] = await Promise.all([
      queryAll(DB.projects),
      queryAll(DB.collections),
      queryAll(DB.items),
      queryAll(DB.tasks),
    ]);

    // -------------------------------------------------------------------------
    // 2. Transform to app objects, filter archived pages.
    //    Notion's queryAll can include archived pages if they were archived
    //    after the query started — guard here just in case.
    // -------------------------------------------------------------------------
    const projects    = projectPages   .filter(p => !p.archived).map(notionPageToProject);
    const collections = collectionPages.filter(p => !p.archived).map(notionPageToCollection);
    const items       = itemPages      .filter(p => !p.archived).map(notionPageToItem);
    const tasks       = taskPages      .filter(p => !p.archived).map(notionPageToTask);

    // -------------------------------------------------------------------------
    // 3. Build lookup maps for O(1) parent resolution.
    // -------------------------------------------------------------------------
    const projectMap    = new Map(projects   .map(p => [p.notionId, p]));
    const collectionMap = new Map(collections.map(c => [c.notionId, c]));

    // -------------------------------------------------------------------------
    // 4. Group tasks by item.
    //    Tasks with no Item relation are orphans — skip them.
    // -------------------------------------------------------------------------
    const tasksByItem = new Map();
    for (const task of tasks) {
      if (!task.itemNotionId) continue;
      if (!tasksByItem.has(task.itemNotionId)) tasksByItem.set(task.itemNotionId, []);
      tasksByItem.get(task.itemNotionId).push(task);
    }

    // -------------------------------------------------------------------------
    // 5. Attach stages to items and route each item to its parent container.
    //    Routing order: collection → project.items (no collection) → standalone
    // -------------------------------------------------------------------------
    const standaloneItems = [];

    for (const item of items) {
      // Reconstruct stages from flat task rows
      const itemTasks = tasksByItem.get(item.notionId) ?? [];
      item.stages = reconstructStages(itemTasks);

      // Derive activeStage index from currentStage name (UI default; app may
      // override from its own localStorage on render).
      if (item.currentStage && item.stages.length > 0) {
        const idx = item.stages.findIndex(s => s.name === item.currentStage);
        item.activeStage = idx >= 0 ? idx : 0;
      }

      // Route to parent
      if (item.collectionNotionId && collectionMap.has(item.collectionNotionId)) {
        collectionMap.get(item.collectionNotionId).items.push(item);
      } else if (item.projectNotionId && projectMap.has(item.projectNotionId)) {
        projectMap.get(item.projectNotionId).items.push(item);
      } else {
        standaloneItems.push(item);
      }
    }

    // -------------------------------------------------------------------------
    // 6. Sort items within collections.
    //    KDP items: sort by monthNumber ASC, then edition order (His/Hers/Ours).
    //    Everything else: title ASC.
    // -------------------------------------------------------------------------
    const EDITION_ORDER = { His: 0, Hers: 1, Ours: 2, None: 3 };

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
    // 7. Attach collections to projects, sort by sortOrder.
    // -------------------------------------------------------------------------
    for (const collection of collections) {
      if (collection.projectNotionId && projectMap.has(collection.projectNotionId)) {
        projectMap.get(collection.projectNotionId).collections.push(collection);
      }
      // Collections with no matching project are silently dropped —
      // they reference an archived or missing project page.
    }

    for (const project of projects) {
      project.collections.sort((a, b) => a.sortOrder - b.sortOrder);
    }

    // -------------------------------------------------------------------------
    // 8. Sort projects: Active first, then by title.
    // -------------------------------------------------------------------------
    projects.sort((a, b) => {
      const sa = PROJECT_STATUS_ORDER[a.status] ?? 99;
      const sb = PROJECT_STATUS_ORDER[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      return a.title.localeCompare(b.title);
    });

    // -------------------------------------------------------------------------
    // 9. Return the assembled tree.
    //    customTemplates is always {} — stored in localStorage only.
    //    standalone catches items not attached to any project.
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
