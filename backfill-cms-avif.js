/**
 * Backfill CMS image fields to current ImageKit delivery settings
 * (default: w-1200, q-60, f-avif) without re-uploading to ImageKit.
 *
 * Pause scheduled sync first. Fingerprint-matched machines are still rewritten.
 *
 * Usage (load site env first):
 *   node backfill-cms-avif.js --dry-run
 *   node backfill-cms-avif.js --limit 5
 *   node backfill-cms-avif.js 11097515
 *   node backfill-cms-avif.js
 *   node backfill-cms-avif.js --publish
 *   node backfill-cms-avif.js --force-upload   # re-upload from feed, then PATCH
 *
 * WS:  $env:DOTENV_CONFIG_PATH="ws.env"; node backfill-cms-avif.js
 * WT:  $env:DOTENV_CONFIG_PATH="wt.env"; node backfill-cms-avif.js
 */

require("dotenv/config");
const {
  isImageKitEnabled,
  GALLERY_WIDTH,
  THUMB_WIDTH,
  QUALITY,
  FORMAT,
} = require("./imagekitImages");
const {
  fetchFeedMachines,
  getAllCollectionItems,
  buildKeeperMap,
  migrateOneMachine,
  publishCmsItems,
} = require("./imagekitMigrate");

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positionals = argv.filter((a) => !a.startsWith("--"));
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
    identifier: positionals[0] || null,
    dryRun: flags.has("--dry-run"),
    publish: flags.has("--publish"),
    forceUpload: flags.has("--force-upload"),
    limit: Number.isFinite(limit) ? limit : null,
  };
}

function machineStockNumber(machine) {
  return String(machine.stockNumber ?? machine.stocknumber ?? "").trim();
}

function matchesMachineIdentifier(machine, identifier) {
  const key = String(identifier).trim();
  if (!key) return false;
  return String(machine.id) === key || machineStockNumber(machine) === key;
}

async function main() {
  const { identifier, dryRun, publish, forceUpload, limit } = parseArgs(
    process.argv.slice(2)
  );

  console.log("CMS AVIF / transform URL backfill");
  console.log("  collection:", process.env.COLLECTION_ID);
  console.log("  ik folder: ", process.env.IMAGEKIT_UPLOAD_FOLDER);
  console.log("  endpoint:  ", process.env.IMAGEKIT_URL_ENDPOINT);
  console.log(
    `  transforms: w-gallery=${GALLERY_WIDTH}, w-thumb=${THUMB_WIDTH}, q=${QUALITY}, f-${FORMAT}`
  );
  console.log("  mode:      ", forceUpload ? "re-upload + PATCH" : "rewrite URLs only (no upload)");
  console.log("  dry-run:   ", dryRun);
  console.log("  publish:   ", publish);
  if (identifier) console.log("  machine:   ", identifier);
  if (limit) console.log("  limit:     ", limit);

  if (!isImageKitEnabled()) {
    throw new Error("Set IMAGEKIT_API_KEY and IMAGEKIT_URL_ENDPOINT");
  }
  if (!process.env.WEBFLOW_API_TOKEN || !process.env.COLLECTION_ID) {
    throw new Error("WEBFLOW_API_TOKEN and COLLECTION_ID are required");
  }

  const [machines, items] = await Promise.all([
    fetchFeedMachines(),
    getAllCollectionItems(process.env.COLLECTION_ID),
  ]);

  const keeperMap = buildKeeperMap(items);
  let queue = machines.filter((m) => keeperMap.has(String(m.id)));

  if (identifier) {
    queue = queue.filter((m) => matchesMachineIdentifier(m, identifier));
    if (!queue.length) {
      throw new Error(
        `No feed+CMS match for ${identifier} (unique-id or stock number)`
      );
    }
  }
  if (limit) queue = queue.slice(0, limit);

  console.log(`\nFeed machines: ${machines.length}`);
  console.log(`CMS keepers:   ${keeperMap.size}`);
  console.log(`To process:    ${queue.length}`);

  const stats = { migrated: 0, skipped: 0, failed: 0 };
  const migratedItemIds = [];
  const failures = [];

  for (let i = 0; i < queue.length; i++) {
    const machine = queue[i];
    const uniqueId = String(machine.id);
    const cmsItem = keeperMap.get(uniqueId);
    const label = `[${i + 1}/${queue.length}] ${uniqueId}`;

    try {
      const result = await migrateOneMachine(machine, cmsItem, {
        dryRun,
        forceUpload,
        forceRewrite: true,
      });

      if (result.status === "migrated" || result.status === "dry-run") {
        stats.migrated++;
        if (result.itemId) migratedItemIds.push(result.itemId);
        console.log(
          `${label} ${result.name} — ${result.status} (${result.imageCount} images)`
        );
        if (result.sampleUrl) console.log(`    sample: ${result.sampleUrl}`);
      } else {
        stats.skipped++;
        console.log(`${label} — skipped (${result.reason})`);
      }
    } catch (err) {
      stats.failed++;
      failures.push({ uniqueId, error: err.message || String(err) });
      console.error(`${label} FAILED:`, err.message || err);
    }
  }

  console.log("\n--- Summary ---");
  console.log(`  migrated/dry-run: ${stats.migrated}`);
  console.log(`  skipped:          ${stats.skipped}`);
  console.log(`  failed:           ${stats.failed}`);

  if (failures.length) {
    console.log("\nFailures:");
    failures.slice(0, 10).forEach((f) => console.log(`  ${f.uniqueId}: ${f.error}`));
    if (failures.length > 10) console.log(`  ... and ${failures.length - 10} more`);
  }

  if (publish && !dryRun && migratedItemIds.length) {
    console.log(`\nPublishing ${migratedItemIds.length} CMS items...`);
    const pub = await publishCmsItems(migratedItemIds);
    console.log("  published:", pub.publishedItemIds?.length || 0);
  } else if (publish && dryRun) {
    console.log("\n--publish ignored during --dry-run");
  } else if (!dryRun) {
    console.log(
      "\nCMS updated. Add --publish to publish items, or publish from Webflow."
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nBackfill failed:", err.message || err);
    process.exit(1);
  });
}
