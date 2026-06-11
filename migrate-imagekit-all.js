/**
 * Bulk ImageKit migration — all active feed machines with CMS keepers.
 *
 * Usage (load site env first):
 *   node migrate-imagekit-all.js --dry-run
 *   node migrate-imagekit-all.js --limit 5
 *   node migrate-imagekit-all.js --skip-imagekit
 *   node migrate-imagekit-all.js
 *   node migrate-imagekit-all.js --publish
 *
 * WS:  $env:DOTENV_CONFIG_PATH="ws.env"; node migrate-imagekit-all.js
 * WT:  $env:DOTENV_CONFIG_PATH="wt.env"; node migrate-imagekit-all.js
 */

require("dotenv/config");
const { isImageKitEnabled } = require("./imagekitImages");
const {
  fetchFeedMachines,
  getAllCollectionItems,
  buildKeeperMap,
  migrateOneMachine,
  publishCmsItems,
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
    publish: flags.has("--publish"),
    skipImagekit: flags.has("--skip-imagekit"),
    forceUpload: flags.has("--force-upload"),
    limit: Number.isFinite(limit) ? limit : null,
  };
}

async function main() {
  const { dryRun, publish, skipImagekit, forceUpload, limit } = parseArgs(
    process.argv.slice(2)
  );

  console.log("ImageKit bulk migration");
  console.log("  collection:", process.env.COLLECTION_ID);
  console.log("  ik folder: ", process.env.IMAGEKIT_UPLOAD_FOLDER);
  console.log("  endpoint:  ", process.env.IMAGEKIT_URL_ENDPOINT);
  console.log("  dry-run:   ", dryRun);
  console.log("  skip-ik:   ", skipImagekit);
  console.log("  force:     ", forceUpload);
  console.log("  publish:   ", publish);
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
  if (limit) queue = queue.slice(0, limit);

  console.log(`\nFeed machines: ${machines.length}`);
  console.log(`CMS keepers:   ${keeperMap.size}`);
  console.log(`To process:    ${queue.length}`);

  const stats = {
    migrated: 0,
    skipped: 0,
    failed: 0,
    published: 0,
  };
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
        skipImagekit,
        forceUpload,
      });

      if (result.status === "migrated" || result.status === "dry-run") {
        stats.migrated++;
        if (result.itemId) migratedItemIds.push(result.itemId);
        console.log(
          `${label} ${result.name} — ${result.status} (${result.imageCount} images)`
        );
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
    console.log("\nCMS updated. Add --publish to publish items, or publish from Webflow.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nBulk migration failed:", err.message || err);
    process.exit(1);
  });
}
