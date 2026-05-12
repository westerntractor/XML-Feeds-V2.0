const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const HEROKU_URL = "https://appwtwebsite.herokuapp.com";
const XML_URL = "https://www.machinefinder.com/dealer_families/9336/machine_feed.xml?key=b562ff30-f65b-0131-e164-005056be003c&password=Deere4";

async function runSync() {
  try {
    // 1. Get current Webflow items from your new server route
    const invRes = await axios.get(`${HEROKU_URL}/collection/inventory`);
    const inventory = invRes.data;

    // 2. Get the MachineFinder XML
    const xmlRes = await axios.get(XML_URL);
    const parser = new XMLParser();
    const jsonObj = parser.parse(xmlRes.data);
    const machines = jsonObj.machine_feed.machines.machine;

    // 3. Loop through machines and decide: Update or Add?
    for (const machine of machines) {
      const machineId = machine.id.toString();
      const payload = {
        fields: {
          name: `${machine.manufacturer} ${machine.model}`,
          unique_id: parseInt(machineId), // This matches your Number field
          advertisedPriceAmount: machine.price?.amount || 0,
          manufacturer_text: machine.manufacturer,
          model_text: machine.model,
          // Add other fields from your CMS SS here
        }
      };

      if (inventory[machineId]) {
        // ID exists in Webflow - Send to Update
        payload.existingItemId = inventory[machineId];
      }

      await axios.post(`${HEROKU_URL}/collection/item/sync`, payload);
    }

    // 4. Auto-Publish when done
    await axios.post(`${HEROKU_URL}/site/publish`);
    console.log("Sync Complete and Site Published!");

  } catch (e) {
    console.error("Sync failed:", e.message);
  }
}

runSync();
