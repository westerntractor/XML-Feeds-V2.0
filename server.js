require("dotenv/config");
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");
const { webflowRequest, SITE_PUBLISH_COOLDOWN_MS } = require("./rateLimit");
const {
  PUBLISH_CHUNK_SIZE,
  getJob: getPublishJob,
  startPublishJob,
  publishItemsSync,
  publicJobView: publicPublishJobView,
} = require("./publishJobs");
const {
  getJob: getArchiveJob,
  startArchiveJob,
  publicJobView: publicArchiveJobView,
} = require("./archiveJobs");
const {
  buildSyncFieldsForUpdate,
  imagesSyncEqual,
  nonImageFieldsEqual,
} = require("./fieldMap");
const {
  isImageSyncDebug,
  log: debugLog,
  logEnvSnapshot,
  logInventorySummary,
  logServerPatch,
  diagnoseImageFields,
} = require("./imageSyncDebug");
const {
  getCatalogMachines,
  queryUsedEquipment,
} = require("./usedEquipmentCatalog");

const app = express();

const port = process.env.PORT ?? 8001;

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

const siteId = process.env.SITE_ID || "60e761d4be0c836d2973fe26";
const collectionId = process.env.COLLECTION_ID || "63090c9ea77ee20faacea709";

const customDomainIds = (
  process.env.CUSTOM_DOMAIN_IDS ||
  "621d322c2758f70acb582292,621d322c2758f768ca582291"
)
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const webflowConfig = {
  headers: {
    Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
    "accept-version": "2.0.0",
    "content-type": "application/json",
  },
};

function forwardWebflowError(res, e, fallbackMessage) {
  const status = e.response?.status || 500;
  const body = e.response?.data || fallbackMessage;
  console.error(fallbackMessage, body);
  res.status(status).send(body);
}

function slugify(name, uniqueId) {
  const base = String(name || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "item"}-${uniqueId}`;
}

function buildItemBody(fields, { isUpdate = false } = {}) {
  const uniqueId = fields["unique-id"];
  const fieldData = { ...fields };

  if (isUpdate) {
    delete fieldData.slug;
  } else {
    fieldData.slug = fields.slug || slugify(fields.name, uniqueId);
  }

  return {
    isDraft: false,
    isArchived: false,
    fieldData,
  };
}

async function getAllCollectionItems() {
  const items = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items?offset=${offset}&limit=${limit}`;
    const response = await webflowRequest(
      () => axios.get(url, webflowConfig),
      { label: "inventory-page" }
    );
    const batch = response.data.items || [];
    items.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  return items;
}

function pickKeeper(candidates) {
  const active = candidates.filter((item) => !item.isArchived);
  const pool = active.length ? active : candidates;
  return pool.sort(
    (a, b) =>
      new Date(b.lastUpdated || 0).getTime() -
      new Date(a.lastUpdated || 0).getTime()
  )[0];
}

function buildInventoryData(items) {
  const byUid = new Map();
  const duplicateItemIds = [];

  for (const item of items) {
    const uniqueId = item.fieldData?.["unique-id"];
    if (uniqueId == null) continue;
    const key = String(uniqueId);
    if (!byUid.has(key)) byUid.set(key, []);
    byUid.get(key).push(item);
  }

  const map = {};
  const fieldsByUniqueId = {};

  for (const [key, group] of byUid) {
    const keeper = pickKeeper(group);
    map[key] = keeper.id;
    fieldsByUniqueId[key] = keeper.fieldData;
    for (const item of group) {
      if (item.id !== keeper.id) duplicateItemIds.push(item.id);
    }
  }

  return { map, fieldsByUniqueId, duplicateItemIds };
}

function resolveFeedKeeperIds(items, incomingUniqueIds) {
  const incoming = new Set(incomingUniqueIds.map((id) => String(id)));
  const byUid = new Map();

  for (const item of items) {
    const uniqueId = item.fieldData?.["unique-id"];
    if (uniqueId == null) continue;
    const key = String(uniqueId);
    if (!incoming.has(key)) continue;
    if (!byUid.has(key)) byUid.set(key, []);
    byUid.get(key).push(item);
  }

  const keeperItemIds = [];
  const skippedArchived = [];
  const missingInCms = [];

  for (const uniqueId of incoming) {
    const group = byUid.get(uniqueId);
    if (!group?.length) {
      missingInCms.push(uniqueId);
      continue;
    }
    const keeper = pickKeeper(group);
    if (keeper.isArchived) {
      skippedArchived.push({ uniqueId, itemId: keeper.id });
    } else {
      keeperItemIds.push(keeper.id);
    }
  }

  return { keeperItemIds, skippedArchived, missingInCms };
}

async function archiveItemById(itemId, label) {
  const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;
  await webflowRequest(
    () =>
      axios.patch(
        url,
        { isArchived: true, isDraft: false },
        webflowConfig
      ),
    { label }
  );
}

app.get("/collection/inventory", async (req, res) => {
  try {
    const items = await getAllCollectionItems();
    const { map, fieldsByUniqueId } = buildInventoryData(items);
    if (isImageSyncDebug()) {
      logInventorySummary(fieldsByUniqueId, map);
    }
    res.json({ map, fieldsByUniqueId });
  } catch (e) {
    forwardWebflowError(res, e, "Webflow Inventory Fetch Error:");
  }
});

/**
 * GET paginated used equipment for the custom filter UI.
 * Query: category, make, model, location, yearMin, yearMax, priceMin, priceMax,
 *        q (search), page (default 1), limit (default 12)
 */
app.get("/collection/used-equipment", async (req, res) => {
  try {
    const machines = await getCatalogMachines(getAllCollectionItems);
    res.json(queryUsedEquipment(machines, req.query));
  } catch (e) {
    forwardWebflowError(res, e, "Used Equipment Catalog Error:");
  }
});

/**
 * POST resolve CMS item IDs to publish for machines currently in the feed.
 * Body: { incomingUniqueIds: string[] | number[] }
 */
app.post("/collection/feed-keeper-ids", async (req, res) => {
  const { incomingUniqueIds } = req.body;
  if (!Array.isArray(incomingUniqueIds)) {
    return res.status(400).json({ error: "incomingUniqueIds array is required" });
  }

  try {
    const items = await getAllCollectionItems();
    const result = resolveFeedKeeperIds(items, incomingUniqueIds);
    res.json({
      feedCount: incomingUniqueIds.length,
      keeperCount: result.keeperItemIds.length,
      ...result,
    });
  } catch (e) {
    forwardWebflowError(res, e, "Feed Keeper IDs Error:");
  }
});

const archiveJobContext = () => ({
  getAllCollectionItems,
  buildInventoryData,
  archiveItemById,
});

/**
 * POST archive CMS items no longer in the MachineFinder feed.
 * Body: { incomingUniqueIds: string[] | number[], async?: boolean }
 */
app.post("/collection/archive-removed", async (req, res) => {
  const { incomingUniqueIds, async: runAsync } = req.body;
  if (!Array.isArray(incomingUniqueIds)) {
    return res.status(400).json({ error: "incomingUniqueIds array is required" });
  }

  const useAsync = runAsync === true || runAsync === "true";

  try {
    if (useAsync) {
      const job = startArchiveJob(incomingUniqueIds, archiveJobContext());
      return res.status(202).json({
        jobId: job.id,
        status: job.status,
        message: "Archive job started",
      });
    }

    const incoming = new Set(incomingUniqueIds.map((id) => String(id)));
    const items = await getAllCollectionItems();
    const { duplicateItemIds } = buildInventoryData(items);
    const archivedIds = new Set(
      items.filter((item) => item.isArchived).map((item) => item.id)
    );
    const archivedItemIds = [];
    const errors = [];
    let skippedAlreadyArchived = 0;

    for (const itemId of duplicateItemIds) {
      if (archivedIds.has(itemId)) {
        skippedAlreadyArchived++;
        continue;
      }
      try {
        await archiveItemById(itemId, `archive-duplicate:${itemId}`);
        archivedItemIds.push(itemId);
      } catch (e) {
        errors.push({ itemId, error: e.response?.data || e.message });
      }
    }

    for (const item of items) {
      if (item.isArchived) continue;
      const uniqueId = item.fieldData?.["unique-id"];
      if (uniqueId == null) continue;
      if (!incoming.has(String(uniqueId))) {
        try {
          await archiveItemById(item.id, `archive-removed:${uniqueId}`);
          archivedItemIds.push(item.id);
        } catch (e) {
          errors.push({
            itemId: item.id,
            uniqueId: String(uniqueId),
            error: e.response?.data || e.message,
          });
        }
      }
    }

    res.json({ archivedItemIds, skippedAlreadyArchived, errors });
  } catch (e) {
    forwardWebflowError(res, e, "Archive Removed Error:");
  }
});

app.get("/archive-jobs/:jobId", (req, res) => {
  const job = getArchiveJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(publicArchiveJobView(job));
});

app.post("/collection/item/sync", async (req, res) => {
  const { fields, existingItemId, existingFields } = req.body;
  if (!fields?.name) {
    return res.status(400).send("fields.name is required");
  }

  try {
    if (existingItemId) {
      const prior = existingFields || {};
      const patchFields = buildSyncFieldsForUpdate(prior, fields);
      if (!patchFields) {
        console.log(`Unchanged: ${fields.name} (${existingItemId})`);
        return res.json({
          id: existingItemId,
          action: "unchanged",
          publish: false,
        });
      }

      const imagesChanged = !imagesSyncEqual(prior, fields);
      const metaChanged = !nonImageFieldsEqual(prior, fields);
      const updateKind =
        imagesChanged && metaChanged
          ? "metadata+images"
          : imagesChanged
            ? "images-only"
            : "metadata-only";

      logServerPatch(fields["unique-id"], fields.name, existingItemId, {
        imagesChanged,
        metaChanged,
        updateKind,
        patchKeys: Object.keys(patchFields),
        imageDiagnosis: imagesChanged
          ? diagnoseImageFields(prior, fields)
          : null,
      });

      const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${existingItemId}`;
      const body = buildItemBody(patchFields, { isUpdate: true });
      console.log(
        `Updating machine [${updateKind}]: ${fields.name} (${existingItemId})`
      );
      const result = await webflowRequest(
        () => axios.patch(url, body, webflowConfig),
        { label: `sync-update:${fields["unique-id"]}` }
      );
      return res.json({
        ...result.data,
        action: "update",
        publish: true,
      });
    }

    const url = `https://api.webflow.com/v2/collections/${collectionId}/items`;
    const body = buildItemBody(fields);
    console.log(`Adding new machine: ${fields.name}`);
    const result = await webflowRequest(
      () => axios.post(url, body, webflowConfig),
      { label: `sync-create:${fields["unique-id"]}` }
    );
    return res.json({
      ...result.data,
      action: "create",
      publish: true,
    });
  } catch (e) {
    forwardWebflowError(res, e, "Sync Error:");
  }
});

app.post("/collection/items/publish", async (req, res) => {
  const { itemIds, async: runAsync } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: "itemIds array is required" });
  }

  const useAsync = runAsync === true || runAsync === "true";

  try {
    if (useAsync) {
      const job = startPublishJob(itemIds, collectionId, webflowConfig);
      return res.status(202).json({
        jobId: job.id,
        status: job.status,
        total: job.total,
        message: "CMS publish job started",
      });
    }

    if (itemIds.length > PUBLISH_CHUNK_SIZE) {
      return res.status(400).json({
        error: `More than ${PUBLISH_CHUNK_SIZE} items requires async: true. Use POST with async or publish-jobs endpoint.`,
      });
    }

    const result = await publishItemsSync(itemIds, collectionId, webflowConfig);
    console.log(`Published ${result.publishedItemIds.length} CMS items (sync)`);
    res.json(result);
  } catch (e) {
    forwardWebflowError(res, e, "CMS Publish Error:");
  }
});

app.get("/publish-jobs/:jobId", (req, res) => {
  const job = getPublishJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(publicPublishJobView(job));
});

app.post("/site/publish", async (req, res) => {
  try {
    const url = `https://api.webflow.com/v2/sites/${siteId}/publish`;
    const data = {
      customDomains: customDomainIds,
      publishToWebflowSubdomain: false,
    };
    const result = await webflowRequest(
      () => axios.post(url, data, webflowConfig),
      {
        label: "site-publish",
        maxRetries: 8,
        baseMs: SITE_PUBLISH_COOLDOWN_MS,
        maxMs: SITE_PUBLISH_COOLDOWN_MS * 2,
      }
    );
    console.log("Site publish queued:", result.status, result.data);
    res.json({ message: "Site published successfully", data: result.data });
  } catch (e) {
    forwardWebflowError(res, e, "Publish Error:");
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  if (isImageSyncDebug()) {
    console.log("IMAGE_SYNC_DEBUG: ON — verbose image sync logging enabled");
    logEnvSnapshot("server-start");
  }
});
