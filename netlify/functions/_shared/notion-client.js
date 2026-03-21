// _shared/notion-client.js
// Singleton Notion SDK client + DB ID map.
// All functions require() this — never import the SDK directly elsewhere.

const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB = {
  projects:    process.env.NOTION_PROJECTS_DB_ID,
  collections: process.env.NOTION_COLLECTIONS_DB_ID,
  items:       process.env.NOTION_ITEMS_DB_ID,
  tasks:       process.env.NOTION_TASKS_DB_ID,
  perf:        process.env.NOTION_PERF_DB_ID,
};

// Paginate through all results from a Notion DB query.
// Handles Notion's 100-row page limit transparently.
async function queryAll(databaseId, filter = undefined, sorts = undefined) {
  const results = [];
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      ...(filter && { filter }),
      ...(sorts && { sorts }),
      ...(cursor && { start_cursor: cursor }),
      page_size: 100,
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

// Archive a Notion page (Notion's equivalent of delete via API).
async function archivePage(pageId) {
  return notion.pages.update({ page_id: pageId, archived: true });
}

// Archive an array of page IDs in parallel (safe batch size of 10).
async function archivePages(pageIds) {
  const BATCH = 10;
  for (let i = 0; i < pageIds.length; i += BATCH) {
    const batch = pageIds.slice(i, i + BATCH);
    await Promise.all(batch.map(id => archivePage(id)));
  }
}

module.exports = { notion, DB, queryAll, archivePage, archivePages };
