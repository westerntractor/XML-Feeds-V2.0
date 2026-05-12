require("dotenv/config");
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");
const app = express();
const port = process.env.PORT ?? 8001;

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Updated Constants
const siteId = "60e761d4be0c836d2973fe26";
const collectionId = "63090c9ea77ee20faacea709"; // Your verified ID
const config = {
  headers: {
    Authorization: `Bearer 4182751cd912ec9378c39911fa04d124dfa028819228ee1ee7856a770aa6fe52`,
    "accept-version": "1.0.0",
    "content-type": "application/json",
  },
};

// 1. NEW: Fetch current Webflow items to build the "Lookup Map"
app.get("/collection/inventory", async (req, res) => {
  try {
    const url = `https://api.webflow.com/collections/${collectionId}/items`;
    const response = await axios.get(url, config);
    
    // Create a map of { unique_id: webflow_item_id }
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

// 2. UPDATED: Smart Add/Update Route
app.post("/collection/item/sync", async (req, res) => {
  const { fields, existingItemId } = req.body;
  let url = `https://api.webflow.com/collections/${collectionId}/items`;
  let result;

  try {
    if (existingItemId) {
      // UPDATE existing item
      console.log(`Updating machine: ${fields.name} (${existingItemId})`);
      url += `/${existingItemId}`;
      result = await axios.patch(url, { fields }, config);
    } else {
      // CREATE new item
      console.log(`Adding new machine: ${fields.name}`);
      result = await axios.post(url, { fields }, config);
    }
    res.send(result.data);
  } catch (e) {
    console.log("Sync Error:", e.response?.data || e.message);
    res.status(500).send(e.response?.data || "Error during sync");
  }
});

// 3. NEW: Auto-Publish Route
app.post("/site/publish", async (req, res) => {
  try {
    const url = `https://api.webflow.com/sites/${siteId}/publish`;
    const data = { domains: ["www.westerntractor.ca"] };
    const result = await axios.post(url, data, config);
    res.send("Site published successfully");
  } catch (e) {
    console.error("Publish Error:", e.response?.data || e.message);
    res.status(500).send("Failed to publish site");
  }
});
