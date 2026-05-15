require("dotenv/config");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

// Ensure this matches your HEROKU_APP_URL exactly
const HEROKU_URL = process.env.HEROKU_APP_URL || "https://appwtwebsite-363a14feb8d4.herokuapp.com";

async function runSync() {
  try {
    console.log("Starting sync process...");

    // 1. Get current inventory
    const invRes = await axios.get(`${HEROKU_URL}/collection/inventory`);
    const inventory = invRes.data;

    // 2. Fetch MachineFinder XML using POST
    console.log("Fetching XML from MachineFinder...");
    const xmlRes = await axios.post(process.env.XML_FEED_URL, {
      key: process.env.MACHINEFINDER_KEY,
      password: process.env.MACHINEFINDER_PASSWORD
    });

    const parser = new XMLParser();
    const jsonObj = parser.parse(xmlRes.data);
    
    let machines = jsonObj.machine_feed.machines.machine;
    if (!Array.isArray(machines)) machines = [machines];

    console.log(`Found ${machines.length} machines. Starting sync...`);

    // 3. Loop through machines
    for (const machine of machines) {
      const machineId = machine.id.toString();
      const payload = {
        fields: {
          name: `${machine.manufacturer} ${machine.model}`,
          "unique-id": parseInt(machineId), // Matches v2 slug style
          "advertised-price-amount": machine.price?.amount || 0,
          "manufacturer-text": machine.manufacturer,
          "model-text": machine.model,
        }
      };

      if (inventory[machineId]) {
        payload.existingItemId = inventory[machineId];
      }

      await axios.post(`${HEROKU_URL}/collection/item/sync`, payload);
    }

    // 4. Publish
    await axios.post(`${HEROKU_URL}/site/publish`);
    console.log("Sync Complete and Site Published!");

  } catch (e) {
    console.error("Sync failed:", e.response?.data || e.message);
  }
}

runSync();
