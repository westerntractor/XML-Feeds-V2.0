require("dotenv/config");
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");
const { webflowRequest, sleep, SITE_PUBLISH_COOLDOWN_MS } = require("./rateLimit");

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

function buildItemBody(fields) {
  const uniqueId = fields["unique-id"];
  return {
    isDraft: false,
    isArchived: false,
    fieldData: {
      ...fields,
      slug: fields.slug || slugify(fields.name, uniqueId),
    },
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

app.get("/collection/inventory", async (req, res) => {
  try {
    const items = await getAllCollectionItems();
    const inventoryMap = {};

    for (const item of items) {
      const uniqueId = item.fieldData?.["unique-id"];
      if (uniqueId != null) {
        inventoryMap[String(uniqueId)] = item.id;
      }
    }

    res.json(inventoryMap);
  } catch (e) {
    forwardWebflowError(res, e, "Webflow Inventory Fetch Error:");
  }
});

app.post("/collection/item/sync", async (req, res) => {
  const { fields, existingItemId } = req.body;
  if (!fields?.name) {
    return res.status(400).send("fields.name is required");
  }

  const body = buildItemBody(fields);
  let url = `https://api.webflow.com/v2/collections/${collectionId}/items`;

  try {
    let result;
    if (existingItemId) {
      console.log(`Updating machine: ${fields.name} (${existingItemId})`);
      url += `/${existingItemId}`;
      result = await webflowRequest(
        () => axios.patch(url, body, webflowConfig),
        { label: `sync-update:${fields["unique-id"]}` }
      );
    } else {
      console.log(`Adding new machine: ${fields.name}`);
      result = await webflowRequest(
        () => axios.post(url, body, webflowConfig),
        { label: `sync-create:${fields["unique-id"]}` }
      );
    }
    res.json(result.data);
  } catch (e) {
    forwardWebflowError(res, e, "Sync Error:");
  }
});

app.post("/collection/items/publish", async (req, res) => {
  const { itemIds } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: "itemIds array is required" });
  }

  try {
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items/publish`;
    const published = [];
    const errors = [];
    const chunkSize = 100;

    for (let i = 0; i < itemIds.length; i += chunkSize) {
      const chunk = itemIds.slice(i, i + chunkSize);
      const result = await webflowRequest(
        () => axios.post(url, { itemIds: chunk }, webflowConfig),
        { label: `cms-publish-chunk-${i / chunkSize + 1}` }
      );
      if (result.data?.publishedItemIds) {
        published.push(...result.data.publishedItemIds);
      }
      if (result.data?.errors?.length) {
        errors.push(...result.data.errors);
      }
    }

    console.log(`Published ${published.length} CMS items`);
    res.json({ publishedItemIds: published, errors });
  } catch (e) {
    forwardWebflowError(res, e, "CMS Publish Error:");
  }
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
});
