require("dotenv/config");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const {
  webflowRequest,
  sleep,
  MIN_INTERVAL_MS,
  SITE_PUBLISH_COOLDOWN_MS,
} = require("./rateLimit");

const HEROKU_URL =
  process.env.HEROKU_APP_URL ||
  "https://appwtwebsite-363a14feb8d4.herokuapp.com";

const PUBLISH_CHUNK_SIZE = parseInt(process.env.PUBLISH_CHUNK_SIZE || "50", 10);
const JOB_POLL_INTERVAL_MS = parseInt(
  process.env.PUBLISH_JOB_POLL_MS || "3000",
  10
);

const webflowConfig = {
  headers: {
    Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
    "accept-version": "2.0.0",
    "content-type": "application/json",
  },
};

const SYNC_FIELD_KEYS = [
  "name",
  "unique-id",
  "advertised-price-amount",
  "manufacturer-text",
  "model-text",
];

function normalizeSyncFields(fields) {
  return {
    name: String(fields?.name || "").trim(),
    "unique-id": Number(fields?.["unique-id"]),
    "advertised-price-amount": Number(fields?.["advertised-price-amount"]) || 0,
    "manufacturer-text": String(fields?.["manufacturer-text"] ?? "N/A"),
    "model-text": String(fields?.["model-text"] ?? "N/A"),
  };
}

function syncFieldsEqual(existingFieldData, incomingFields) {
  const a = normalizeSyncFields(existingFieldData);
  const b = normalizeSyncFields(incomingFields);
  return SYNC_FIELD_KEYS.every((key) => a[key] === b[key]);
}

function parseInventoryResponse(data) {
  if (data?.map) {
    return { map: data.map, fieldsByUniqueId: data.fieldsByUniqueId || {} };
  }
  return { map: data, fieldsByUniqueId: {} };
}

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
    throw new Error(
      "Could not find the 'machine' list in the XML data. Check MachineFinder feed."
    );
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

function herokuRequest(fn, label) {
  return webflowRequest(fn, { label });
}

async function syncOneMachine(payload, machineId, labelSuffix = "") {
  const res = await herokuRequest(
    () => axios.post(`${HEROKU_URL}/collection/item/sync`, payload),
    `sync-item${labelSuffix}:${machineId}`
  );
  return res.data;
}

async function syncMachineWithRetry(
  machine,
  inventory,
  fieldsByUniqueId,
  changedItemIds,
  stats,
  failed,
  isRetry = false
) {
  const machineId = machine.id?.toString();
  if (!machineId) return;

  const fields = buildFields(machine);
  const existingItemId =
    inventory[machineId] || inventory[parseInt(machineId, 10)];
  const existingFields = fieldsByUniqueId[machineId];

  if (existingItemId && existingFields && syncFieldsEqual(existingFields, fields)) {
    stats.unchanged++;
    return;
  }

  const payload = { fields, existingItemId, existingFields };

  try {
    const data = await syncOneMachine(
      payload,
      machineId,
      isRetry ? "-retry" : ""
    );

    if (data.action === "unchanged") {
      stats.unchanged++;
      return;
    }

    if (data.publish && data.id) {
      changedItemIds.push(data.id);
    }

    if (data.action === "create") stats.created++;
    else if (data.action === "update") stats.updated++;

    console.log(
      `${isRetry ? "Synced (retry)" : "Synced"} [${data.action}]: ${fields.name}`
    );
  } catch (syncErr) {
    if (!isRetry) {
      failed.push({ machine, machineId });
    }
    stats.failed++;
    console.error(
      `Failed to sync machine ${machineId}:`,
      syncErr.response?.data || syncErr.message
    );
  }
}

async function pollJob(jobId, endpoint, label) {
  while (true) {
    const res = await axios.get(`${HEROKU_URL}/${endpoint}/${jobId}`);
    const job = res.data;

    if (job.status === "done") {
      return job;
    }

    if (job.status === "failed") {
      throw new Error(job.error || `${label} job failed`);
    }

    console.log(
      `${label} job ${job.status}: ${job.processed || 0}/${job.total || "?"}...`
    );
    await sleep(JOB_POLL_INTERVAL_MS);
  }
}

async function archiveRemovedMachines(incomingUniqueIds) {
  console.log(
    `Starting async archive for items not in feed (${incomingUniqueIds.length} active ids)...`
  );

  const startRes = await herokuRequest(
    () =>
      axios.post(`${HEROKU_URL}/collection/archive-removed`, {
        incomingUniqueIds,
        async: true,
      }),
    "archive-removed-start"
  );

  const jobId = startRes.data.jobId;
  if (!jobId) {
    throw new Error("Server did not return an archive jobId");
  }

  console.log(`Archive job started: ${jobId}`);
  const job = await pollJob(jobId, "archive-jobs", "Archive");

  const count = job.archivedItemIds?.length || 0;
  console.log(`Archived ${count} removed/duplicate items`);
  if (job.errors?.length) {
    console.warn("Archive errors:", job.errors);
  }
  return job.archivedItemIds || [];
}

async function pollPublishJob(jobId) {
  const job = await pollJob(jobId, "publish-jobs", "CMS publish");
  console.log(
    `CMS publish job complete: ${job.publishedItemIds?.length || 0} published`
  );
  if (job.errors?.length) {
    console.warn("CMS publish errors:", job.errors);
  }
  return job;
}

async function publishCmsItems(itemIds) {
  const unique = [...new Set(itemIds)];
  if (!unique.length) {
    console.log("No CMS items to publish");
    return;
  }

  console.log(
    `Starting async CMS publish for ${unique.length} changed items (chunks of ${PUBLISH_CHUNK_SIZE})...`
  );

  const startRes = await herokuRequest(
    () =>
      axios.post(`${HEROKU_URL}/collection/items/publish`, {
        itemIds: unique,
        async: true,
      }),
    "cms-publish-start"
  );

  const jobId = startRes.data.jobId;
  if (!jobId) {
    throw new Error("Server did not return a publish jobId");
  }

  console.log(`CMS publish job started: ${jobId}`);
  await pollPublishJob(jobId);
}

async function publishSite() {
  console.log(
    `Waiting ${Math.round(SITE_PUBLISH_COOLDOWN_MS / 1000)}s before site publish (Webflow 1/min limit)...`
  );
  await sleep(SITE_PUBLISH_COOLDOWN_MS);

  console.log("Requesting site publish...");
  const res = await herokuRequest(
    () => axios.post(`${HEROKU_URL}/site/publish`),
    "site-publish"
  );
  console.log("Site publish:", res.data?.message || res.data);
}

async function runSync() {
  console.log("Starting sync process...");
  console.log(
    `Throttle: ${MIN_INTERVAL_MS}ms (~${process.env.WEBFLOW_RATE_LIMIT_PER_MINUTE || 120}/min), publish chunks: ${PUBLISH_CHUNK_SIZE}`
  );

  const invRes = await herokuRequest(
    () => axios.get(`${HEROKU_URL}/collection/inventory`),
    "inventory"
  );
  const { map: inventory, fieldsByUniqueId } = parseInventoryResponse(
    invRes.data
  );

  console.log("Fetching XML from MachineFinder...");
  const xmlRes = await axios.post(process.env.XML_FEED_URL, {
    key: process.env.MACHINEFINDER_KEY,
    password: process.env.MACHINEFINDER_PASSWORD,
  });

  const machines = parseMachines(xmlRes.data);
  console.log(`Found ${machines.length} machines. Starting sync...`);

  const incomingUniqueIds = machines
    .map((m) => m.id?.toString())
    .filter(Boolean);

  const changedItemIds = [];
  const failed = [];
  const stats = { created: 0, updated: 0, unchanged: 0, failed: 0 };

  for (const machine of machines) {
    await syncMachineWithRetry(
      machine,
      inventory,
      fieldsByUniqueId,
      changedItemIds,
      stats,
      failed
    );
  }

  if (failed.length) {
    console.log(`Retrying ${failed.length} failed machines...`);
    for (const { machine } of failed) {
      await syncMachineWithRetry(
        machine,
        inventory,
        fieldsByUniqueId,
        changedItemIds,
        stats,
        [],
        true
      );
    }
  }

  console.log(
    `Sync loop finished — created: ${stats.created}, updated: ${stats.updated}, unchanged: ${stats.unchanged}, failed: ${stats.failed}`
  );

  const archivedItemIds = await archiveRemovedMachines(incomingUniqueIds);
  const archivedCount = archivedItemIds.length;
  const changedCount = changedItemIds.length;

  // Archived items cannot use items/publish — site publish applies removals live.
  if (changedCount > 0) {
    console.log(`${changedCount} created/updated items queued for CMS publish`);
    await publishCmsItems(changedItemIds);
  } else {
    console.log("No created/updated items — skipping CMS item publish");
  }

  if (changedCount > 0 || archivedCount > 0) {
    if (archivedCount > 0) {
      console.log(
        `${archivedCount} archived items will be reflected on the live site via site publish`
      );
    }
    await publishSite();
  } else {
    console.log("No changes or archives — skipping site publish");
  }

  console.log("Sync complete.");
}

async function doPublish() {
  console.log("Publishing site only...");
  await publishSite();
  console.log("Site publish complete.");
}

async function fetchSite() {
  const siteId = process.env.SITE_ID;
  if (!siteId) throw new Error("Missing SITE_ID in environment");
  const response = await webflowRequest(
    () => axios.get(`https://api.webflow.com/v2/sites/${siteId}`, webflowConfig),
    { label: "fetch-site", throttle: false }
  );
  return response.data;
}

async function fetchCustomDomains() {
  const siteId = process.env.SITE_ID;
  if (!siteId) throw new Error("Missing SITE_ID in environment");
  const response = await webflowRequest(
    () =>
      axios.get(
        `https://api.webflow.com/v2/sites/${siteId}/custom_domains`,
        webflowConfig
      ),
    { label: "fetch-domains", throttle: false }
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
