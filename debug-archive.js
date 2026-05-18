require("dotenv/config");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const COLLECTION_ID = process.env.COLLECTION_ID;
const SITE_ID = process.env.SITE_ID;
const TOKEN = process.env.WEBFLOW_API_TOKEN;
const CUSTOM_DOMAINS = (
  process.env.CUSTOM_DOMAIN_IDS ||
  "621d322c2758f70acb582292,621d322c2758f768ca582291"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const wf = {
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "accept-version": "2.0.0",
    "content-type": "application/json",
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseMachines(xmlData) {
  const json = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
  }).parse(xmlData);
  let machines;
  if (json.machine_feed?.machines?.machine) {
    machines = json.machine_feed.machines.machine;
  } else if (json.machine_feed?.machine) {
    machines = json.machine_feed.machine;
  } else if (json.machines?.machine) {
    machines = json.machines.machine;
  }
  if (!machines) throw new Error("No machines in XML feed");
  return Array.isArray(machines) ? machines : [machines];
}

async function getFeedIds() {
  const { data } = await axios.post(process.env.XML_FEED_URL, {
    key: process.env.MACHINEFINDER_KEY,
    password: process.env.MACHINEFINDER_PASSWORD,
  });
  const machines = parseMachines(data);
  return new Set(machines.map((m) => String(m.id)));
}

async function getAllItems() {
  const items = [];
  let offset = 0;
  while (true) {
    const { data } = await axios.get(
      `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items?offset=${offset}&limit=100`,
      wf
    );
    const batch = data.items || [];
    items.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
  }
  return items;
}

async function getItem(itemId) {
  const { data } = await axios.get(
    `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${itemId}`,
    wf
  );
  return data;
}

async function archiveOne(itemId) {
  const { data } = await axios.patch(
    `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${itemId}`,
    { isArchived: true, isDraft: false },
    wf
  );
  return data;
}

async function sitePublish() {
  const { data, status } = await axios.post(
    `https://api.webflow.com/v2/sites/${SITE_ID}/publish`,
    { customDomains: CUSTOM_DOMAINS, publishToWebflowSubdomain: false },
    wf
  );
  return { status, data };
}

function summarize(item) {
  return {
    id: item.id,
    uniqueId: item.fieldData?.["unique-id"],
    name: item.fieldData?.name,
    isArchived: item.isArchived,
    isDraft: item.isDraft,
    lastUpdated: item.lastUpdated,
  };
}

(async () => {
  const incoming = await getFeedIds();
  const items = await getAllItems();

  const candidates = items.filter((i) => {
    const uid = i.fieldData?.["unique-id"];
    return uid != null && !incoming.has(String(uid)) && !i.isArchived;
  });

  console.log("Feed count:", incoming.size);
  console.log("CMS items:", items.length);
  console.log("Archive candidates (active, not in feed):", candidates.length);
  console.log("Already archived:", items.filter((i) => i.isArchived).length);

  const test = candidates[0];
  if (!test) {
    console.log("No candidate — all orphans archived or feed matches CMS.");
    return;
  }

  const testUid = test.fieldData["unique-id"];
  const dupes = items.filter(
    (i) => String(i.fieldData?.["unique-id"]) === String(testUid)
  );
  if (dupes.length > 1) {
    console.log("\nDuplicate rows for same unique-id:");
    console.log(
      dupes.map((i) => ({
        id: i.id,
        isArchived: i.isArchived,
        lastUpdated: i.lastUpdated,
      }))
    );
  }

  console.log("\n=== BEFORE ===");
  console.log(summarize(await getItem(test.id)));

  console.log("\n=== ARCHIVE (PATCH) ===");
  console.log(summarize(await archiveOne(test.id)));

  console.log("\n=== AFTER ARCHIVE (GET) ===");
  const afterArchive = summarize(await getItem(test.id));
  console.log(afterArchive);
  if (!afterArchive.isArchived) {
    console.error("FAIL: isArchived still false after PATCH");
    process.exit(1);
  }

  console.log("\n=== SITE PUBLISH ===");
  console.log(await sitePublish());

  console.log("\nWaiting 65s (site publish cooldown)...");
  await sleep(65000);

  console.log("\n=== AFTER SITE PUBLISH (GET) ===");
  const afterPublish = summarize(await getItem(test.id));
  console.log(afterPublish);

  const items2 = await getAllItems();
  const candidates2 = items2.filter((i) => {
    const uid = i.fieldData?.["unique-id"];
    return uid != null && !incoming.has(String(uid)) && !i.isArchived;
  });
  console.log(
    "\nArchive candidates now:",
    candidates2.length,
    "(was",
    candidates.length + ")"
  );
  console.log(
    "Test item still in candidate list?",
    candidates2.some((i) => i.id === test.id)
  );
})().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
