/**
 * End-to-end Cloudinary test: fetch transform URL + upload from MachineFinder URL.
 * Usage: node cloudinary-test.js
 */
require("dotenv/config");
const axios = require("axios");
const { v2: cloudinary } = require("cloudinary");
const { XMLParser } = require("fast-xml-parser");

const TEST_MACHINE_ID = process.env.CLOUDINARY_TEST_MACHINE_ID || "11500214";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function configureCloudinary() {
  cloudinary.config({
    cloud_name: requireEnv("CLOUDINARY_CLOUD_NAME"),
    api_key: requireEnv("CLOUDINARY_API_KEY"),
    api_secret: requireEnv("CLOUDINARY_API_SECRET"),
    secure: true,
  });
}

function buildFetchUrl(sourceUrl, { width = 1600 } = {}) {
  return cloudinary.url(sourceUrl, {
    type: "fetch",
    secure: true,
    sign_url: true,
    transformation: [{ width, crop: "limit", quality: "auto", fetch_format: "auto" }],
  });
}

async function getSampleImageUrl(machineId) {
  const xml = (
    await axios.post(process.env.XML_FEED_URL, {
      key: process.env.MACHINEFINDER_KEY,
      password: process.env.MACHINEFINDER_PASSWORD,
    })
  ).data;
  const j = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
  }).parse(xml);
  let machines = j.machines?.machine;
  if (!Array.isArray(machines)) machines = [machines];
  const machine = machines.find((m) => String(m.id) === String(machineId));
  if (!machine) throw new Error(`Machine ${machineId} not in feed`);

  let imgs = machine.images?.image;
  if (!imgs) throw new Error("No images on machine");
  if (!Array.isArray(imgs)) imgs = [imgs];
  const primary =
    imgs.find((i) => i.primary === "true") || imgs[0];
  const url = primary.filePointerLarge || primary.filePointer;
  if (!url) throw new Error("No image URL on first image");
  return { machineId, url, imageCount: imgs.length };
}

async function probeUrl(label, url) {
  const head = await axios.head(url, {
    timeout: 60000,
    maxRedirects: 5,
    validateStatus: (s) => s < 500,
  });
  const size = head.headers["content-length"];
  const type = head.headers["content-type"];
  console.log(`  ${label}: HTTP ${head.status}, type=${type}, size=${size ? `${Math.round(size / 1024)} KB` : "unknown"}`);
  return { status: head.status, size: size ? Number(size) : null, type };
}

async function testFetch(sourceUrl) {
  console.log("\n=== 1. FETCH TRANSFORM URL (signed) ===");
  const fetchUrl = buildFetchUrl(sourceUrl, { width: 1600 });
  console.log("  Source (truncated):", sourceUrl.slice(0, 72) + "...");
  console.log("  Fetch URL (truncated):", fetchUrl.slice(0, 90) + "...");

  await probeUrl("MachineFinder original", sourceUrl);
  const fetchProbe = await probeUrl("Cloudinary fetch (w_1600)", fetchUrl);
  if (fetchProbe.status !== 200) {
    throw new Error(`Fetch URL returned HTTP ${fetchProbe.status}`);
  }
  return fetchUrl;
}

async function testUpload(sourceUrl, machineId) {
  console.log("\n=== 2. UPLOAD FROM URL ===");
  const publicId = `wt-test/${machineId}/primary-e2e`;
  const result = await cloudinary.uploader.upload(sourceUrl, {
    public_id: publicId,
    overwrite: true,
    resource_type: "image",
    transformation: [{ width: 1600, crop: "limit", quality: "auto", fetch_format: "auto" }],
  });

  console.log("  public_id:", result.public_id);
  console.log("  secure_url (truncated):", result.secure_url.slice(0, 90) + "...");
  console.log("  bytes:", result.bytes, `(${Math.round(result.bytes / 1024)} KB)`);
  console.log("  format:", result.format, "width:", result.width, "height:", result.height);

  await probeUrl("Uploaded asset", result.secure_url);

  console.log("\n=== 3. CLEANUP (delete test upload) ===");
  const del = await cloudinary.uploader.destroy(result.public_id);
  console.log("  destroy result:", del.result);

  return result.secure_url;
}

async function main() {
  console.log("Cloudinary E2E test");
  console.log("  cloud_name:", process.env.CLOUDINARY_CLOUD_NAME);

  configureCloudinary();
  const { machineId, url, imageCount } = await getSampleImageUrl(TEST_MACHINE_ID);
  console.log("\n=== FEED SAMPLE ===");
  console.log("  machine id:", machineId);
  console.log("  images in feed:", imageCount);

  let fetchUrl = null;
  try {
    fetchUrl = await testFetch(url);
  } catch (fetchErr) {
    console.warn("\n  Fetch test failed:", fetchErr.message);
    console.warn("  (Account may require signed fetch or upload-only — continuing to upload test)");
  }

  const uploadUrl = await testUpload(url, machineId);

  console.log("\n=== PASS ===");
  if (fetchUrl) console.log("Fetch: OK — signed fetch URLs work for Webflow.");
  else console.log("Fetch: skipped/failed — use upload URLs in sync instead.");
  console.log("Upload: OK —", uploadUrl.slice(0, 100) + "...");
}

main().catch((e) => {
  console.error("\n=== FAIL ===");
  console.error(e.response?.data || e.message || e);
  process.exit(1);
});
