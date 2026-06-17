/**
 * Shared ImageKit migration helpers (single-machine + bulk).
 */

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const { webflowRequest } = require("./rateLimit");
const { getImageUrls, secondGalleryFieldSlug, cmsGalleryLayoutMatches } = require("./fieldMap");
const {
  computeImageSourceFingerprint,
  feedImagesUnchanged,
  fingerprintFieldSlug,
} = require("./imageSourceFingerprint");
const {
  isImageKitEnabled,
  uploadMachineImages,
  mapImageKitFields,
  buildDeliveryUrl,
  GALLERY_WIDTH,
} = require("./imagekitImages");

function webflowConfig() {
  return {
    headers: {
      Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
      "accept-version": "2.0.0",
      "content-type": "application/json",
    },
  };
}

function parseMachines(xmlData) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
  });
  const jsonObj = parser.parse(xmlData);

  let machines;
  if (jsonObj.machine_feed?.machines?.machine) {
    machines = jsonObj.machine_feed.machines.machine;
  } else if (jsonObj.machine_feed?.machine) {
    machines = jsonObj.machine_feed.machine;
  } else if (jsonObj.machines?.machine) {
    machines = jsonObj.machines.machine;
  }

  if (!machines) {
    throw new Error("Could not find machines in XML feed");
  }
  return Array.isArray(machines) ? machines : [machines];
}

async function fetchFeedMachines() {
  const feedUrl = process.env.XML_FEED_URL;
  if (!feedUrl) throw new Error("XML_FEED_URL is not set");
  if (!process.env.MACHINEFINDER_KEY || !process.env.MACHINEFINDER_PASSWORD) {
    throw new Error("MACHINEFINDER_KEY and MACHINEFINDER_PASSWORD are required");
  }

  const response = await axios.post(feedUrl, {
    key: process.env.MACHINEFINDER_KEY,
    password: process.env.MACHINEFINDER_PASSWORD,
  });
  return parseMachines(response.data);
}

function pickKeeper(items) {
  const active = items.filter((item) => !item.isArchived);
  const pool = active.length ? active : items;
  return pool.sort(
    (a, b) =>
      new Date(b.lastUpdated || 0).getTime() -
      new Date(a.lastUpdated || 0).getTime()
  )[0];
}

async function getAllCollectionItems(collectionId) {
  const items = [];
  let offset = 0;
  const limit = 100;
  const config = webflowConfig();

  while (true) {
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items?offset=${offset}&limit=${limit}`;
    const response = await webflowRequest(() => axios.get(url, config), {
      label: "imagekit-list-items",
    });
    const batch = response.data.items || [];
    items.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return items;
}

function buildKeeperMap(items) {
  const byUid = new Map();
  for (const item of items) {
    const uid = item.fieldData?.["unique-id"];
    if (uid == null) continue;
    const key = String(uid);
    const existing = byUid.get(key);
    if (!existing) {
      byUid.set(key, item);
      continue;
    }
    byUid.set(key, pickKeeper([existing, item]));
  }
  return byUid;
}

async function resolveImageFieldsForMachine(
  machine,
  existingFieldData = null,
  { forceUpload = false } = {}
) {
  const sourceUrls = getImageUrls(machine);
  if (!sourceUrls.length) return {};

  const uniqueId = String(machine.id);
  const secondGallery = secondGalleryFieldSlug();

  if (!isImageKitEnabled()) {
    throw new Error("IMAGEKIT_API_KEY and IMAGEKIT_URL_ENDPOINT must be set");
  }

  const filePaths = await uploadMachineImages(uniqueId, sourceUrls, {
    quiet: !forceUpload,
  });

  const imageFields = mapImageKitFields(filePaths, secondGallery);
  imageFields[fingerprintFieldSlug()] = computeImageSourceFingerprint(sourceUrls);
  return imageFields;
}

async function patchCmsImages(itemId, imageFields) {
  const collectionId = process.env.COLLECTION_ID;
  const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;
  const body = {
    isDraft: false,
    isArchived: false,
    fieldData: imageFields,
  };

  const result = await webflowRequest(
    () => axios.patch(url, body, webflowConfig()),
    { label: `imagekit-patch:${itemId}` }
  );
  return result.data;
}

async function publishCmsItems(itemIds) {
  if (!itemIds.length) return { publishedItemIds: [] };

  const collectionId = process.env.COLLECTION_ID;
  const chunkSize = parseInt(process.env.PUBLISH_CHUNK_SIZE || "50", 10);
  const publishedItemIds = [];

  for (let i = 0; i < itemIds.length; i += chunkSize) {
    const chunk = itemIds.slice(i, i + chunkSize);
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items/publish`;
    const result = await webflowRequest(
      () => axios.post(url, { itemIds: chunk }, webflowConfig()),
      { label: `imagekit-publish:${i}` }
    );
    publishedItemIds.push(...(result.data?.publishedItemIds || chunk));
  }

  return { publishedItemIds };
}

async function migrateOneMachine(machine, cmsItem, options = {}) {
  const { dryRun = false, skipImagekit = false, forceUpload = false } = options;
  const uniqueId = String(machine.id);
  const name = `${machine.manufacturer || ""} ${machine.model || ""}`.trim();
  const sourceUrls = getImageUrls(machine);

  if (!sourceUrls.length) {
    return { status: "skipped", reason: "no-images", uniqueId, name };
  }

  if (!cmsItem) {
    return { status: "skipped", reason: "no-cms-item", uniqueId, name };
  }

  if (
    skipImagekit &&
    feedImagesUnchanged(cmsItem.fieldData, sourceUrls) &&
    cmsGalleryLayoutMatches(cmsItem.fieldData, sourceUrls)
  ) {
    return {
      status: "skipped",
      reason: "fingerprint-match",
      uniqueId,
      name,
      itemId: cmsItem.id,
    };
  }

  if (dryRun) {
    return {
      status: "dry-run",
      uniqueId,
      name,
      itemId: cmsItem.id,
      imageCount: sourceUrls.length,
    };
  }

  const imageFields = await resolveImageFieldsForMachine(
    machine,
    cmsItem.fieldData,
    { forceUpload: forceUpload || !skipImagekit }
  );
  await patchCmsImages(cmsItem.id, imageFields);

  return {
    status: "migrated",
    uniqueId,
    name,
    itemId: cmsItem.id,
    imageCount: sourceUrls.length,
    sampleUrl: imageFields["image-gallery"]?.[0]?.url,
  };
}

module.exports = {
  fetchFeedMachines,
  getAllCollectionItems,
  buildKeeperMap,
  pickKeeper,
  resolveImageFieldsForMachine,
  patchCmsImages,
  publishCmsItems,
  migrateOneMachine,
  buildDeliveryUrl,
  GALLERY_WIDTH,
};
