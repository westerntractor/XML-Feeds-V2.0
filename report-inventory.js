require("dotenv/config");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const wf = {
  headers: {
    Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
    "accept-version": "2.0.0",
  },
};

function parseMachines(xml) {
  const j = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
  }).parse(xml);
  let m = j.machines?.machine;
  return Array.isArray(m) ? m : [m];
}

function feedPrice(m) {
  const ap = m.advertised_price;
  if (ap != null && typeof ap === "object") {
    const v = ap.amount ?? ap["#text"] ?? ap._;
    if (v != null) return parseFloat(v);
  }
  if (ap != null) return parseFloat(ap);
  return parseFloat(m.price?.amount || 0) || 0;
}

function imageCount(m) {
  const img = m.images?.image;
  if (Array.isArray(img)) return img.length;
  if (img) return 1;
  return 0;
}

async function getAllItems() {
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const { data } = await axios.get(
      `https://api.webflow.com/v2/collections/${process.env.COLLECTION_ID}/items?offset=${offset}&limit=100`,
      wf
    );
    const batch = data.items || [];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

(async () => {
  const xml = (
    await axios.post(process.env.XML_FEED_URL, {
      key: process.env.MACHINEFINDER_KEY,
      password: process.env.MACHINEFINDER_PASSWORD,
    })
  ).data;
  const feed = parseMachines(xml);
  const feedIds = new Set(feed.map((m) => String(m.id)));
  const items = await getAllItems();

  const hasPrice = (i) => Number(i.fieldData?.["advertised-price-amount"]) > 0;
  const active = items.filter((i) => !i.isArchived);
  const archived = items.filter((i) => i.isArchived);

  console.log("=== CMS OVERVIEW ===");
  console.log("Total:", items.length);
  console.log("With unique-id:", items.filter((i) => i.fieldData?.["unique-id"] != null).length);
  console.log("Without unique-id:", items.filter((i) => i.fieldData?.["unique-id"] == null).length);
  console.log("Archived:", archived.length);
  console.log("Active:", active.length);
  console.log(
    "Active in feed:",
    active.filter((i) => feedIds.has(String(i.fieldData?.["unique-id"]))).length
  );
  console.log(
    "Active NOT in feed:",
    active.filter((i) => !feedIds.has(String(i.fieldData?.["unique-id"]))).length
  );
  console.log("Active price > 0:", active.filter(hasPrice).length);
  console.log("Active price 0/missing:", active.filter((i) => !hasPrice(i)).length);
  console.log("Feed count:", feed.length);

  const feedWithPrice = feed.filter((m) => feedPrice(m) > 0).length;
  const feedSyncWouldZero = feed.filter(
    (m) => (parseFloat(m.price?.amount || 0) || 0) === 0
  ).length;
  console.log("Feed machines with advertised_price > 0:", feedWithPrice);
  console.log("Feed machines where sync path price.amount is 0:", feedSyncWouldZero);

  const needle = "9570RX";
  const feedHits = feed.filter((m) => String(m.model || "").includes(needle));
  console.log("\n=== FEED:", needle, "===");
  console.log("Count in feed:", feedHits.length);
  for (const m of feedHits) {
    console.log({
      feedId: m.id,
      manufacturer: m.manufacturer,
      model: m.model,
      feedPrice: feedPrice(m),
      syncWouldWritePrice: parseFloat(m.price?.amount || 0) || 0,
      imagesInFeed: imageCount(m),
    });
  }

  const cmsHits = items.filter((i) =>
    `${i.fieldData?.name || ""} ${i.fieldData?.["model-text"] || ""}`.includes(needle)
  );
  console.log("\n=== CMS rows for", needle, "===");
  console.log("Count:", cmsHits.length);
  for (const i of cmsHits) {
    const fd = i.fieldData || {};
    const imageSlugs = Object.keys(fd).filter((k) =>
      /image|photo|gallery|thumb/i.test(k)
    );
    console.log({
      itemId: i.id,
      uniqueId: fd["unique-id"],
      name: fd.name,
      cmsPrice: fd["advertised-price-amount"],
      isArchived: i.isArchived,
      inFeed: feedIds.has(String(fd["unique-id"])),
      lastUpdated: i.lastUpdated,
      imageFieldSlugs: imageSlugs,
      imageFieldSample: imageSlugs.reduce((acc, k) => {
        const v = fd[k];
        acc[k] = Array.isArray(v) ? `array(${v.length})` : typeof v;
        return acc;
      }, {}),
      allFieldSlugs: Object.keys(fd).sort().join(", "),
    });
  }
})().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
