/**
 * Backfill image_source_fingerprint on CMS items (feed hash only — no image changes).
 *
 * Usage:
 *   node backfill-image-fingerprints.js --dry-run
 *   node backfill-image-fingerprints.js --limit 5
 *   node backfill-image-fingerprints.js
 *
 * WS: $env:DOTENV_CONFIG_PATH="ws.env"; node backfill-image-fingerprints.js
 * WT: $env:DOTENV_CONFIG_PATH="wt.env"; node backfill-image-fingerprints.js
 */

require("dotenv/config");
const axios = require("axios");
const { webflowRequest } = require("./rateLimit");
const { getImageUrls } = require("./fieldMap");
const {
  fingerprintFieldSlug,
  computeImageSourceFingerprint,
  readStoredFingerprint,
} = require("./imageSourceFingerprint");
const {
  fetchFeedMachines,
  getAllCollectionItems,
  buildKeeperMap,
} = require("./imagekitMigrate");

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  let limit = null;
  for (const arg of argv) {
    const m = arg.match(/^--limit=(\d+)$/);
    if (m) limit = parseInt(m[1], 10);
  }
  const limitFlagIdx = argv.indexOf("--limit");
  if (limitFlagIdx >= 0 && argv[limitFlagIdx + 1]) {
    limit = parseInt(argv[limitFlagIdx + 1], 10);
  }
  return {
    dryRun: flags.has("--dry-run"),
    limit: Number.isFinite(limit) ? limit : null,
  };
}

function webflowConfig() {
  return {
    headers: {
      Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
      "accept-version": "2.0.0",
      "content-type": "application/json",
    },
  };
}

async function patchFingerprintOnly(itemId, fingerprint) {
  const collectionId = process.env.COLLECTION_ID;
  const slug = fingerprintFieldSlug();
  const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;
  const body = {
    isDraft: false,
    isArchived: false,
    fieldData: { [slug]: fingerprint },
  };
  const result = await webflowRequest(
    () => axios.patch(url, body, webflowConfig()),
    { label: `fingerprint-backfill:${itemId}` }
  );
  return result.data;
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));
  const slug = fingerprintFieldSlug();

  console.log("Image source fingerprint backfill");
  console.log("  field:    ", slug);
  console.log("  collection:", process.env.COLLECTION_ID);
  console.log("  dry-run:  ", dryRun);
  if (limit) console.log("  limit:    ", limit);

  if (!process.env.WEBFLOW_API_TOKEN || !process.env.COLLECTION_ID) {
    throw new Error("WEBFLOW_API_TOKEN and COLLECTION_ID are required");
  }

  const [machines, items] = await Promise.all([
    fetchFeedMachines(),
    getAllCollectionItems(process.env.COLLECTION_ID),
  ]);

  const keeperMap = buildKeeperMap(items);
  let queue = machines.filter((m) => keeperMap.has(String(m.id)));
  if (limit) queue = queue.slice(0, limit);

  console.log(`\nFeed machines: ${queue.length} (of ${machines.length})`);

  const stats = { updated: 0, skipped: 0, noImages: 0, failed: 0 };

  for (let i = 0; i < queue.length; i++) {
    const machine = queue[i];
    const uniqueId = String(machine.id);
    const cmsItem = keeperMap.get(uniqueId);
    const name = `${machine.manufacturer || ""} ${machine.model || ""}`.trim();
    const sourceUrls = getImageUrls(machine);
    const label = `[${i + 1}/${queue.length}] ${uniqueId}`;

    if (!sourceUrls.length) {
      stats.noImages++;
      console.log(`${label} — skip (no feed images)`);
      continue;
    }

    const fingerprint = computeImageSourceFingerprint(sourceUrls);
    const stored = readStoredFingerprint(cmsItem?.fieldData);

    if (stored === fingerprint) {
      stats.skipped++;
      console.log(`${label} ${name} — already set`);
      continue;
    }

    if (dryRun) {
      stats.updated++;
      console.log(
        `${label} ${name} — would set ${fingerprint.slice(0, 12)}... (was: ${stored || "(empty)"})`
      );
      continue;
    }

    try {
      await patchFingerprintOnly(cmsItem.id, fingerprint);
      stats.updated++;
      console.log(`${label} ${name} — fingerprint set`);
    } catch (err) {
      stats.failed++;
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message || String(err);
      console.error(`${label} FAILED:`, detail);
    }
  }

  console.log("\n--- Summary ---");
  console.log("  updated/dry-run:", stats.updated);
  console.log("  already set:    ", stats.skipped);
  console.log("  no feed images: ", stats.noImages);
  console.log("  failed:         ", stats.failed);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nBackfill failed:", err.message || err);
    process.exit(1);
  });
}
