// _shared/transformers.js
// Bidirectional format converters: Notion page properties ↔ app data objects.
// Every function that reads from or writes to Notion runs through here.

// ---------------------------------------------------------------------------
// Safe Notion property accessors
// ---------------------------------------------------------------------------
const txt  = (prop) => prop?.rich_text?.[0]?.plain_text ?? "";
const ttl  = (prop) => prop?.title?.[0]?.plain_text ?? "";
const sel  = (prop) => prop?.select?.name ?? null;
const num  = (prop) => (prop?.number !== undefined && prop.number !== null) ? prop.number : null;
const chk  = (prop) => prop?.checkbox ?? false;
const dt   = (prop) => prop?.date?.start ?? null;
const url  = (prop) => prop?.url ?? null;
const rel1 = (prop) => prop?.relation?.[0]?.id ?? null;

// ---------------------------------------------------------------------------
// Notion → App format
// ---------------------------------------------------------------------------

function notionPageToProject(page) {
  const p = page.properties;
  return {
    notionId:      page.id,
    id:            page.id,          // app uses id field for its own lookups
    title:         ttl(p.Title),
    desc:          txt(p.Description),
    status:        sel(p.Status),
    startDate:     dt(p["Start Date"]),
    targetLaunch:  dt(p["Target Launch"]),
    notes:         txt(p.Notes),
    collapsed:     false,            // UI state — not persisted in Notion
    collections:   [],               // populated during assembly in get-all-data
    items:         [],               // populated during assembly
  };
}

function notionPageToCollection(page) {
  const p = page.properties;
  return {
    notionId:         page.id,
    id:               page.id,
    title:            ttl(p.Title),
    projectNotionId:  rel1(p.Project),
    sortOrder:        num(p["Sort Order"]) ?? 0,
    status:           sel(p.Status),
    notes:            txt(p.Notes),
    items:            [],            // populated during assembly
  };
}

function notionPageToItem(page) {
  const p = page.properties;
  // Notion stores type as "KDP"/"Etsy"/"App"; app expects lowercase
  const rawType = sel(p.Type);
  const type = rawType ? rawType.toLowerCase() : "kdp";

  return {
    notionId:            page.id,
    id:                  page.id,
    title:               ttl(p.Title),
    type,
    etype:               sel(p["Product Type"]) ?? "",
    edition:             sel(p.Edition) ?? "",
    status:              sel(p.Status),
    currentStage:        txt(p["Current Stage"]),
    progressPct:         num(p["Progress %"]) ?? 0,
    monthName:           txt(p["Month Name"]),
    monthNumber:         num(p["Month Number"]),
    projectNotionId:     rel1(p.Project),
    collectionNotionId:  rel1(p.Collection),
    cumulativeRevenue:   num(p["Cumulative Revenue"]) ?? 0,
    cumulativeUnits:     num(p["Cumulative Units"]) ?? 0,
    avgRating:           num(p["Avg Rating"]) ?? 0,
    reviewsCount:        num(p["Reviews Count"]) ?? 0,
    lastUpdated:         dt(p["Last Updated"]),
    notes:               txt(p.Notes),
    // KDP-specific
    bsrOverall:          num(p["BSR Overall"]),
    categoryRank1:       txt(p["Category Rank 1"]),
    categoryRank2:       txt(p["Category Rank 2"]),
    asin:                txt(p.ASIN),
    kdpUrl:              url(p["KDP URL"]),
    // Etsy-specific
    etsyUrl:             url(p["Etsy Listing URL"]),
    favoritesCount:      num(p["Favorites Count"]),
    price:               num(p.Price),
    // App-specific
    platform:            sel(p.Platform),
    appStoreUrl:         url(p["App Store URL"]),
    totalDownloads:      num(p["Total Downloads"]),
    // These are populated during assembly
    stages:              [],
    perf:                { logs: [] },
    activeStage:         0,          // derived from currentStage in get-all-data
  };
}

function notionPageToTask(page) {
  const p = page.properties;
  return {
    notionId:      page.id,
    id:            page.id,
    text:          ttl(p.Title),
    done:          chk(p.Done),
    doneAt:        dt(p["Completed At"]),
    stageName:     txt(p["Stage Name"]),
    stageOrder:    num(p["Stage Order"]) ?? 0,
    taskOrder:     num(p["Task Order"]) ?? 0,
    itemNotionId:  rel1(p.Item),
    notes:         txt(p.Notes),
  };
}

// Reconstruct the stages array for one item from its flat Notion task rows.
// Tasks arrive with stageName + stageOrder + taskOrder — group, sort, derive completion.
function reconstructStages(tasks) {
  if (!tasks || tasks.length === 0) return [];

  // Group by stage name
  const stageMap = new Map();
  for (const task of tasks) {
    const key = task.stageName || "Unnamed Stage";
    if (!stageMap.has(key)) {
      stageMap.set(key, { name: key, stageOrder: task.stageOrder, tasks: [] });
    }
    stageMap.get(key).tasks.push(task);
  }

  // Sort stages by stageOrder
  const stages = Array.from(stageMap.values())
    .sort((a, b) => a.stageOrder - b.stageOrder);

  // Sort tasks within each stage, derive stage completion
  for (const stage of stages) {
    stage.tasks.sort((a, b) => a.taskOrder - b.taskOrder);

    const allDone = stage.tasks.length > 0 && stage.tasks.every(t => t.done);
    let lastDoneAt = null;
    if (allDone) {
      lastDoneAt = stage.tasks.reduce((max, t) => {
        if (!t.doneAt) return max;
        if (!max) return t.doneAt;
        return t.doneAt > max ? t.doneAt : max;
      }, null);
    }

    stage.completed  = allDone;
    stage.completedAt = lastDoneAt;
    delete stage.stageOrder; // internal sort key, not part of app format
  }

  return stages;
}

// ---------------------------------------------------------------------------
// App → Notion property format
// Used by create-item, update-item, log-performance, etc.
// Only includes keys that are explicitly provided (undefined = not sent to Notion).
// ---------------------------------------------------------------------------

function projectToNotionProperties(fields) {
  const props = {};
  if (fields.title  !== undefined) props.Title       = { title:     [{ text: { content: fields.title } }] };
  if (fields.desc   !== undefined) props.Description = { rich_text: [{ text: { content: fields.desc  } }] };
  if (fields.status !== undefined) props.Status      = { select:    { name: fields.status } };
  if (fields.notes  !== undefined) props.Notes       = { rich_text: [{ text: { content: fields.notes } }] };
  if (fields.startDate    !== undefined) props["Start Date"]    = { date: fields.startDate    ? { start: fields.startDate    } : null };
  if (fields.targetLaunch !== undefined) props["Target Launch"] = { date: fields.targetLaunch ? { start: fields.targetLaunch } : null };
  return props;
}

function collectionToNotionProperties(fields) {
  const props = {};
  if (fields.title     !== undefined) props.Title      = { title:     [{ text: { content: fields.title } }] };
  if (fields.sortOrder !== undefined) props["Sort Order"] = { number: fields.sortOrder };
  if (fields.status    !== undefined) props.Status     = { select:    { name: fields.status } };
  if (fields.notes     !== undefined) props.Notes      = { rich_text: [{ text: { content: fields.notes } }] };
  return props;
}

function itemToNotionProperties(fields) {
  const props = {};

  // Core
  if (fields.title        !== undefined) props.Title           = { title:     [{ text: { content: fields.title       } }] };
  if (fields.type         !== undefined) props.Type            = { select:    { name: capitalize(fields.type)         } };
  if (fields.etype        !== undefined) props["Product Type"] = { select:    fields.etype ? { name: fields.etype } : null };
  if (fields.edition      !== undefined) props.Edition         = { select:    fields.edition ? { name: fields.edition } : null };
  if (fields.status       !== undefined) props.Status          = { select:    { name: fields.status                   } };
  if (fields.currentStage !== undefined) props["Current Stage"]= { rich_text: [{ text: { content: fields.currentStage } }] };
  if (fields.progressPct  !== undefined) props["Progress %"]   = { number:    fields.progressPct };
  if (fields.monthName    !== undefined) props["Month Name"]   = { rich_text: [{ text: { content: fields.monthName   } }] };
  if (fields.monthNumber  !== undefined) props["Month Number"] = { number:    fields.monthNumber };
  if (fields.notes        !== undefined) props.Notes           = { rich_text: [{ text: { content: fields.notes       } }] };

  // Perf totals
  if (fields.cumulativeRevenue !== undefined) props["Cumulative Revenue"] = { number: fields.cumulativeRevenue };
  if (fields.cumulativeUnits   !== undefined) props["Cumulative Units"]   = { number: fields.cumulativeUnits   };
  if (fields.avgRating         !== undefined) props["Avg Rating"]         = { number: fields.avgRating         };
  if (fields.reviewsCount      !== undefined) props["Reviews Count"]      = { number: fields.reviewsCount      };
  if (fields.lastUpdated       !== undefined) props["Last Updated"]       = { date:   fields.lastUpdated ? { start: fields.lastUpdated } : null };

  // KDP
  if (fields.bsrOverall    !== undefined) props["BSR Overall"]    = { number:    fields.bsrOverall };
  if (fields.categoryRank1 !== undefined) props["Category Rank 1"]= { rich_text: [{ text: { content: fields.categoryRank1 } }] };
  if (fields.categoryRank2 !== undefined) props["Category Rank 2"]= { rich_text: [{ text: { content: fields.categoryRank2 } }] };
  if (fields.asin          !== undefined) props.ASIN              = { rich_text: [{ text: { content: fields.asin          } }] };
  if (fields.kdpUrl        !== undefined) props["KDP URL"]        = { url:       fields.kdpUrl || null };

  // Etsy
  if (fields.etsyUrl       !== undefined) props["Etsy Listing URL"] = { url:    fields.etsyUrl || null };
  if (fields.favoritesCount!== undefined) props["Favorites Count"]  = { number: fields.favoritesCount };
  if (fields.price         !== undefined) props.Price               = { number: fields.price };

  // App
  if (fields.platform      !== undefined) props.Platform        = { select: fields.platform ? { name: fields.platform } : null };
  if (fields.appStoreUrl   !== undefined) props["App Store URL"]= { url:    fields.appStoreUrl || null };
  if (fields.totalDownloads!== undefined) props["Total Downloads"] = { number: fields.totalDownloads };

  return props;
}

function taskToNotionProperties(fields) {
  const props = {};
  if (fields.text       !== undefined) props.Title          = { title:    [{ text: { content: fields.text } }] };
  if (fields.done       !== undefined) props.Done           = { checkbox: fields.done };
  if (fields.completedAt!== undefined) props["Completed At"]= { date:    fields.completedAt ? { start: fields.completedAt } : null };
  if (fields.stageName  !== undefined) props["Stage Name"]  = { rich_text:[{ text: { content: fields.stageName  } }] };
  if (fields.stageOrder !== undefined) props["Stage Order"] = { number:   fields.stageOrder };
  if (fields.taskOrder  !== undefined) props["Task Order"]  = { number:   fields.taskOrder  };
  if (fields.notes      !== undefined) props.Notes          = { rich_text:[{ text: { content: fields.notes } }] };
  return props;
}

function perfLogToNotionProperties(fields) {
  const titleStr = `${fields.itemTitle || "Item"} — ${fields.logDate || new Date().toISOString().slice(0,10)}`;
  return {
    Title:                    { title:     [{ text: { content: titleStr } }] },
    "Item Type":              { select:    { name: capitalize(fields.itemType || "kdp") } },
    "Log Date":               { date:      { start: fields.logDate } },
    "Units Sold (Period)":    { number:    fields.unitsPeriod     ?? 0 },
    "Revenue (Period)":       { number:    fields.revenuePeriod   ?? 0 },
    "Cumulative Units":       { number:    fields.cumulativeUnits ?? 0 },
    "Cumulative Revenue":     { number:    fields.cumulativeRevenue ?? 0 },
    Views:                    { number:    fields.views    ?? 0 },
    Orders:                   { number:    fields.orders   ?? 0 },
    "Reviews Count":          { number:    fields.reviewsCount ?? 0 },
    "Avg Rating":             { number:    fields.avgRating    ?? 0 },
    "Ad Spend":               { number:    fields.adSpend      ?? 0 },
    "Ad Revenue":             { number:    fields.adRevenue     ?? 0 },
    ...(fields.bsrOverall    ? { "BSR Overall":    { number:    fields.bsrOverall    } } : {}),
    ...(fields.categoryRank1 ? { "Category Rank 1":{ rich_text: [{ text: { content: fields.categoryRank1 } }] } } : {}),
    ...(fields.categoryRank2 ? { "Category Rank 2":{ rich_text: [{ text: { content: fields.categoryRank2 } }] } } : {}),
    "Import Source":          { select:    { name: fields.importSource || "Manual" } },
    Notes:                    { rich_text: [{ text: { content: fields.notes || "" } }] },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// Standard JSON response builder for Netlify functions
function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

module.exports = {
  notionPageToProject,
  notionPageToCollection,
  notionPageToItem,
  notionPageToTask,
  reconstructStages,
  projectToNotionProperties,
  collectionToNotionProperties,
  itemToNotionProperties,
  taskToNotionProperties,
  perfLogToNotionProperties,
  jsonResponse,
};
