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

async function runSync() {
  try {
    console.log("Starting sync process...");

    // 1. Get current inventory from your working Heroku route
    const invRes = await axios.get(`${HEROKU_URL}/collection/inventory`);
    const inventory = invRes.data;

    // 2. Fetch MachineFinder XML
    console.log("Fetching XML from MachineFinder...");
    const xmlRes = await axios.post(process.env.XML_FEED_URL, {
      key: process.env.MACHINEFINDER_KEY,
      password: process.env.MACHINEFINDER_PASSWORD
    });

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: ""
    });
    const jsonObj = parser.parse(xmlRes.data);
    
    // SAFETY CHECK: Locate the machines array regardless of XML nesting
    let machines;
    if (jsonObj.machine_feed && jsonObj.machine_feed.machines) {
        machines = jsonObj.machine_feed.machines.machine;
    } else if (jsonObj.machine_feed && jsonObj.machine_feed.machine) {
        machines = jsonObj.machine_feed.machine;
    } else if (jsonObj.machines && jsonObj.machines.machine) {
        machines = jsonObj.machines.machine;
    }

    if (!machines) {
        throw new Error("Could not find the 'machine' list in the XML data. Check MachineFinder feed.");
    }

    // Force into an array if there is only one machine
    if (!Array.isArray(machines)) machines = [machines];

    console.log(`Found ${machines.length} machines. Starting sync...`);

    // 3. Loop through machines and sync
    for (const machine of machines) {
      const machineId = machine.id?.toString();
      if (!machineId) continue;

      const payload = {
        fields: {
          name: `${machine.manufacturer || ''} ${machine.model || ''}`.trim(),
          "unique-id": parseInt(machineId),
          "advertised-price-amount": parseFloat(machine.price?.amount || 0),
          "manufacturer-text": String(machine.manufacturer ?? "N/A"),
          "model-text": String(machine.model) || "N/A",
        }
      };

      if (inventory[machineId]) {
        payload.existingItemId = inventory[machineId];
      }

      try {
        await axios.post(`${HEROKU_URL}/collection/item/sync`, payload);
        console.log(`Synced: ${payload.fields.name}`);
      } catch (syncErr) {
        console.error(`Failed to sync machine ${machineId}:`, syncErr.response?.data || syncErr.message);
      }
    }

    // 4. Final Publish
    console.log("Sync loop finished. Requesting site publish...");
    await axios.post(`${HEROKU_URL}/site/publish`);
    console.log("Sync Complete and Site Published!");

  } catch (e) {
    console.error("Sync failed:", e.response?.data || e.message);
  }
}

async function doPublish() {
  try {
    console.log("Starting publish process...");
    await axios.post(`${HEROKU_URL}/site/publish`);
    console.log("Publish Complete!");
  } catch (e) {
    console.error("Publish failed:", e.response?.data || e.message);
  }
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


runSync();