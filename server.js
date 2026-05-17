require("dotenv/config");
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");
const app = express();

const port = process.env.PORT ?? 8001;

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

const siteId = "60e761d4be0c836d2973fe26";
const collectionId = process.env.COLLECTION_ID || "63090c9ea77ee20faacea709"; 

// CRITICAL: Updated for Webflow v2
const webflowConfig = {
  headers: {
    Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
    "accept-version": "2.0.0",
    "content-type": "application/json",
  },
};

/**
 * 1. FETCH XML FROM MACHINEFINDER
 */
async function fetchMachineFinderData() {
  try {
    const response = await axios.post(process.env.XML_FEED_URL, {
      key: process.env.MACHINEFINDER_KEY,
      password: process.env.MACHINEFINDER_PASSWORD
    });
    return response.data;
  } catch (e) {
    console.error("MachineFinder Fetch Error:", e.response?.data || e.message);
    throw e;
  }
}

/**
 * 2. GET CURRENT WEBFLOW INVENTORY (v2 Update)
 */
app.get("/collection/inventory", async (req, res) => {
  try {
    // v2 Endpoint
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items`;
    const response = await axios.get(url, webflowConfig);
    
    const inventoryMap = {};
    // v2 uses item.fieldData for custom fields and item.id for the unique Webflow ID
    response.data.items.forEach(item => {
      if (item.fieldData && item.fieldData['unique-id']) {
        inventoryMap[item.fieldData['unique-id']] = item.id;
      }
    });
    
    res.json(inventoryMap);
  } catch (e) {
    console.error("Webflow Inventory Fetch Error:", e.response?.data || e.message);
    res.status(500).send("Failed to fetch inventory");
  }
});

/**
 * 3. SYNC DATA TO WEBFLOW (v2 Update)
 */
app.post("/collection/item/sync", async (req, res) => {
  const { fields, existingItemId } = req.body;
  let url = `https://api.webflow.com/v2/collections/${collectionId}/items`;
  let result;

  try {
    if (existingItemId) {
      console.log(`Updating machine: ${fields.name} (${existingItemId})`);
      url += `/${existingItemId}`;
      // v2 uses 'fieldData' wrapper for updates
      result = await axios.patch(url, { fieldData: fields }, webflowConfig);
    } else {
      console.log(`Adding new machine: ${fields.name}`);
      result = await axios.post(url, { fieldData: fields }, webflowConfig);
    }
    res.send(result.data);
  } catch (e) {
    console.log("Sync Error:", e.response?.data || e.message);
    res.status(500).send(e.response?.data || "Error during sync");
  }
});

/**
 * 4. AUTO-PUBLISH (v2 Update)
 */
app.post("/site/publish", async (req, res) => {
  try {
    const url = `https://api.webflow.com/v2/sites/${siteId}/publish`;
    // v2 requires an array of specific target IDs
    const data = {
      "customDomains": [
        "621d322c2758f70acb582292",
        "621d322c2758f768ca582291"
      ],
      "publishToWebflowSubdomain": false
    }; 
    await axios.post(url, data, webflowConfig);
    res.send("Site published successfully");
  } catch (e) {
    console.error("Publish Error:", e.response?.data || e.message);
    res.status(500).send("Failed to publish site");
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
