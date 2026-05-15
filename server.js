require("dotenv/config");
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");
const app = express();

// Use Heroku's dynamic port or default to 8001
const port = process.env.PORT ?? 8001;

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// Constants pulled from your Heroku Config Vars
const siteId = "60e761d4be0c836d2973fe26";
const collectionId = process.env.COLLECTION_ID || "63090c9ea77ee20faacea709"; 

const webflowConfig = {
  headers: {
    Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
    "accept-version": "1.0.0",
    "content-type": "application/json",
  },
};

/**
 * 1. FETCH XML FROM MACHINEFINDER
 * This is the critical update using POST and your new credentials
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
 * 2. GET CURRENT WEBFLOW INVENTORY
 * Used to see what machines we already have
 */
app.get("/collection/inventory", async (req, res) => {
  try {
    const url = `https://api.webflow.com/collections/${collectionId}/items`;
    const response = await axios.get(url, webflowConfig);
    
    const inventoryMap = {};
    response.data.items.forEach(item => {
      if (item['unique_id']) {
        inventoryMap[item['unique_id']] = item._id;
      }
    });
    
    res.json(inventoryMap);
  } catch (e) {
    console.error("Error fetching inventory", e.response?.data || e.message);
    res.status(500).send("Failed to fetch inventory");
  }
});

/**
 * 3. SYNC DATA TO WEBFLOW
 */
app.post("/collection/item/sync", async (req, res) => {
  const { fields, existingItemId } = req.body;
  let url = `https://api.webflow.com/collections/${collectionId}/items`;
  let result;

  try {
    if (existingItemId) {
      console.log(`Updating machine: ${fields.name} (${existingItemId})`);
      url += `/${existingItemId}`;
      result = await axios.patch(url, { fields }, webflowConfig);
    } else {
      console.log(`Adding new machine: ${fields.name}`);
      result = await axios.post(url, { fields }, webflowConfig);
    }
    res.send(result.data);
  } catch (e) {
    console.log("Sync Error:", e.response?.data || e.message);
    res.status(500).send(e.response?.data || "Error during sync");
  }
});

/**
 * 4. AUTO-PUBLISH
 */
app.post("/site/publish", async (req, res) => {
  try {
    const url = `https://api.webflow.com/sites/${siteId}/publish`;
    const data = { domains: ["www.westerntractor.ca"] };
    const result = await axios.post(url, data, webflowConfig);
    res.send("Site published successfully");
  } catch (e) {
    console.error("Publish Error:", e.response?.data || e.message);
    res.status(500).send("Failed to publish site");
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
