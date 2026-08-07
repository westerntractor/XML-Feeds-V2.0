/**
 * One-machine ImageKit migration test.
 *
 * Usage:
 *   node migrate-imagekit-test.js 825345 --dry-run
 *   node migrate-imagekit-test.js 11719347
 *   node migrate-imagekit-test.js 825345 --publish
 */

require("dotenv/config");
const { getImageUrls } = require("./fieldMap");
const {
  isImageKitEnabled,
  machineFolder,
  galleryUrlsFromFieldData,
} = require("./imagekitImages");
const {
  fetchFeedMachines,
  getAllCollectionItems,
  pickKeeper,
  migrateOneMachine,
  publishCmsItems,
} = require("./imagekitMigrate");

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positionals = argv.filter((a) => !a.startsWith("--"));
  return {
    identifier: positionals[0] || "825345",
    dryRun: flags.has("--dry-run"),
    publish: flags.has("--publish"),
    forceUpload: flags.has("--force-upload"),
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

function matchesCmsIdentifier(item, identifier) {
  const key = String(identifier).trim();
  if (!key) return false;
  const fd = item.fieldData || {};
  return (
    String(fd["unique-id"]) === key ||
    String(fd.stocknumber || "").trim() === key
  );
}

async function findCmsItemByIdentifier(identifier) {
  const collectionId = process.env.COLLECTION_ID;
  if (!collectionId) throw new Error("COLLECTION_ID is not set");

  const items = await getAllCollectionItems(collectionId);
  const matches = items.filter((item) =>
    matchesCmsIdentifier(item, identifier)
  );
  if (!matches.length) return null;
  return pickKeeper(matches);
}

async function main() {
  const { identifier, dryRun, publish, forceUpload } = parseArgs(
    process.argv.slice(2)
  );

  console.log("ImageKit one-machine migration test");
  console.log("  lookup:   ", identifier, "(unique-id or stock number)");
  console.log("  dry-run:  ", dryRun);
  console.log("  publish:  ", publish);
  console.log("  collection:", process.env.COLLECTION_ID);
  console.log("  endpoint: ", process.env.IMAGEKIT_URL_ENDPOINT);

  if (!isImageKitEnabled()) {
    throw new Error("Set IMAGEKIT_API_KEY and IMAGEKIT_URL_ENDPOINT");
  }
  if (!process.env.WEBFLOW_API_TOKEN) {
    throw new Error("WEBFLOW_API_TOKEN is not set");
  }

  const machines = await fetchFeedMachines();
  const machine = machines.find((m) => matchesMachineIdentifier(m, identifier));
  if (!machine) {
    throw new Error(`Machine ${identifier} not found in XML feed`);
  }

  const uniqueId = String(machine.id);
  console.log("  unique-id:", uniqueId);
  console.log("  ik folder:", machineFolder(uniqueId));

  const name = `${machine.manufacturer || ""} ${machine.model || ""}`.trim();
  const sourceUrls = getImageUrls(machine);
  console.log(`\nFeed: ${name} (${sourceUrls.length} images)`);
  if (!sourceUrls.length) {
    throw new Error("No source image URLs in feed for this machine");
  }

  const cmsItem = await findCmsItemByIdentifier(identifier);
  if (!cmsItem) {
    throw new Error(`No CMS item found for ${identifier}`);
  }

  const beforeUrls = galleryUrlsFromFieldData(cmsItem.fieldData);
  console.log(`\nCMS item: ${cmsItem.id}`);
  console.log("  before (first 2 gallery URLs):");
  beforeUrls.slice(0, 2).forEach((u) => console.log(`    ${u}`));

  if (dryRun) {
    console.log("\n--dry-run: would upload these source URLs:");
    sourceUrls.forEach((u, i) => console.log(`  ${i}: ${u}`));
    return;
  }

  const result = await migrateOneMachine(machine, cmsItem, {
    forceUpload,
    forceRewrite: true,
  });
  console.log("\nDone.");
  console.log("  status:", result.status);
  console.log("  gallery images:", result.imageCount);
  console.log("  sample new URL:", result.sampleUrl);

  if (publish) {
    console.log("\nPublishing CMS item...");
    const pub = await publishCmsItems([cmsItem.id]);
    console.log("  published:", pub.publishedItemIds?.length || 0);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nMigration test failed:", err.message || err);
    process.exit(1);
  });
}
