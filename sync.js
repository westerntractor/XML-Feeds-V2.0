require("dotenv/config");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const HEROKU_URL = process.env.HEROKU_APP_URL || "https://appwtwebsite-363a14feb8d4.herokuapp.com";

const webflowConfig = {
  headers: {
    Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
    "accept-version": "2.0.0",
    "content-type": "application/json",
  },
};

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
    throw new Error("Could not find the 'machine' list in the XML data. Check MachineFinder feed.");
  }

  return Array.isArray(machines) ? machines : [machines];
}

function buildFields(machine) {
  const machineId = machine.id?.toString();
  const name = `${machine.manufacturer || ""} ${machine.model || ""}`.trim();

  return {
    name,
    "unique-id": parseInt(machineId, 10),
    "advertised-price-amount": parseFloat(machine.price?.amount || 0),
    "manufacturer-text": String(machine.manufacturer ?? "N/A"),
    "model-text": String(machine.model ?? "N/A"),
  };
}

async function publishCmsItems(itemIds) {
  if (!itemIds.length) {
    console.log("No CMS items to publish");
    return;
  }

  console.log(`Publishing ${itemIds.length} CMS items...`);
  const res = await axios.post(`${HEROKU_URL}/collection/items/publish`, { itemIds });
  console.log(`CMS publish result: ${res.data.publishedItemIds?.length || 0} published`);
  if (res.data.errors?.length) {
    console.warn("CMS publish errors:", res.data.errors);
  }
}

async function publishSite() {
  console.log("Requesting site publish...");
  const res = await axios.post(`${HEROKU_URL}/site/publish`);
  console.log("Site publish:", res.data?.message || res.data);
}

async function runSync() {
  console.log("Starting sync process...");

  const invRes = await axios.get(`${HEROKU_URL}/collection/inventory`);
  const inventory = invRes.data;

  console.log("Fetching XML from MachineFinder...");
  const xmlRes = await axios.post(process.env.XML_FEED_URL, {
    key: process.env.MACHINEFINDER_KEY,
    password: process.env.MACHINEFINDER_PASSWORD,
  });

  const machines = parseMachines(xmlRes.data);
  console.log(`Found ${machines.length} machines. Starting sync...`);

  const syncedItemIds = [];

  for (const machine of machines) {
    const machineId = machine.id?.toString();
    if (!machineId) continue;

    const payload = {
      fields: buildFields(machine),
      existingItemId: inventory[machineId] || inventory[parseInt(machineId, 10)],
    };

    try {
      const res = await axios.post(`${HEROKU_URL}/collection/item/sync`, payload);
      if (res.data?.id) syncedItemIds.push(res.data.id);
      console.log(`Synced: ${payload.fields.name}`);
    } catch (syncErr) {
      console.error(
        `Failed to sync machine ${machineId}:`,
        syncErr.response?.data || syncErr.message
      );
    }
  }

  console.log("Sync loop finished.");
  await publishCmsItems(syncedItemIds);
  await publishSite();
  console.log("Sync complete.");
}

async function doPublish() {
  console.log("Publishing CMS + site (republish existing items skipped — run sync for full flow)...");
  await publishSite();
  console.log("Site publish complete.");
}

async function fetchSite() {
  const siteId = process.env.SITE_ID;
  if (!siteId) throw new Error("Missing SITE_ID in environment");
  const response = await axios.get(
    `https://api.webflow.com/v2/sites/${siteId}`,
    webflowConfig
  );
  return response.data;
}

async function fetchCustomDomains() {
  const siteId = process.env.SITE_ID;
  if (!siteId) throw new Error("Missing SITE_ID in environment");
  const response = await axios.get(
    `https://api.webflow.com/v2/sites/${siteId}/custom_domains`,
    webflowConfig
  );
  return response.data;
}

async function main() {
  const mode = process.argv[2] || "sync";

  if (mode === "site") {
    const site = await fetchSite();
    console.log(JSON.stringify(site, null, 2));
    const domains = await fetchCustomDomains();
    console.log("\nCustom domains:");
    console.log(JSON.stringify(domains, null, 2));
    return;
  }

  if (mode === "publish") {
    await doPublish();
    return;
  }

  await runSync();
}

main().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
