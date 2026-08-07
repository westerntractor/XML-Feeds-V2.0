/** MachineFinder / remote URLs → ImageKit upload + delivery URLs */

const GALLERY_WIDTH = parseInt(process.env.IMAGEKIT_GALLERY_WIDTH || "1200", 10);
const THUMB_WIDTH = parseInt(process.env.IMAGEKIT_THUMB_WIDTH || "800", 10);
const QUALITY = parseInt(process.env.IMAGEKIT_QUALITY || "60", 10);
/** ImageKit output format for CMS import URLs (avif | webp | jpg | auto). */
const FORMAT = String(process.env.IMAGEKIT_FORMAT || "avif").toLowerCase();

/** Webflow multi-image field limit (per field). */
const WEBFLOW_GALLERY_MAX = parseInt(process.env.WEBFLOW_GALLERY_MAX || "25", 10);
/** Max feed images synced across image-gallery + second gallery (25 + 25). */
const MAX_IMAGES_CAP = WEBFLOW_GALLERY_MAX * 2;

/**
 * Split ordered images for Webflow: primary gallery + overflow second gallery.
 * @param {unknown[]} items
 * @returns {{ primary: unknown[], overflow: unknown[] }}
 */
function splitForWebflowGalleries(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    primary: list.slice(0, WEBFLOW_GALLERY_MAX),
    overflow: list.slice(WEBFLOW_GALLERY_MAX, MAX_IMAGES_CAP),
  };
}

function isImageKitEnabled() {
  return Boolean(
    process.env.IMAGEKIT_API_KEY && process.env.IMAGEKIT_URL_ENDPOINT
  );
}

function normalizeFolder(folder) {
  const base = String(folder || "/").replace(/\\/g, "/");
  return base.endsWith("/") ? base : `${base}/`;
}

function machineFolder(uniqueId) {
  const root = normalizeFolder(process.env.IMAGEKIT_UPLOAD_FOLDER || "/");
  return `${root}${uniqueId}/`;
}

function fileExtensionFromUrl(sourceUrl) {
  try {
    const pathname = new URL(sourceUrl).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (match) return match[1].toLowerCase();
  } catch {
    // ignore
  }
  return "jpg";
}

function buildDeliveryUrl(filePath, { width } = {}) {
  const endpoint = String(process.env.IMAGEKIT_URL_ENDPOINT || "").replace(
    /\/$/,
    ""
  );
  const path = String(filePath || "").replace(/^\//, "");
  if (!endpoint || !path) return "";
  if (width) {
    const format = FORMAT === "auto" ? "auto" : FORMAT;
    return `${endpoint}/tr:w-${width},q-${QUALITY},f-${format}/${path}`;
  }
  return `${endpoint}/${path}`;
}

function authHeader() {
  const key = process.env.IMAGEKIT_API_KEY;
  if (!key) throw new Error("IMAGEKIT_API_KEY is not set");
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

/**
 * Upload a remote image URL into ImageKit.
 * @returns {Promise<{ filePath: string, url: string, fileId: string }>}
 */
async function uploadFromUrl(sourceUrl, { fileName, folder } = {}) {
  if (!sourceUrl) throw new Error("sourceUrl is required");
  if (!isImageKitEnabled()) {
    throw new Error("IMAGEKIT_API_KEY and IMAGEKIT_URL_ENDPOINT must be set");
  }

  const form = new FormData();
  form.append("file", sourceUrl);
  form.append("fileName", fileName);
  if (folder) form.append("folder", normalizeFolder(folder));
  form.append("useUniqueFileName", "false");
  form.append("overwriteFile", "true");

  const response = await fetch("https://upload.imagekit.io/api/v1/files/upload", {
    method: "POST",
    headers: { Authorization: authHeader() },
    body: form,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data.message || data.error || response.statusText;
    throw new Error(`ImageKit upload failed (${response.status}): ${msg}`);
  }

  return {
    filePath: data.filePath,
    url: data.url,
    fileId: data.fileId,
  };
}

function toWebflowImage(filePath, role = "gallery") {
  const width = role === "thumb" ? THUMB_WIDTH : GALLERY_WIDTH;
  return { url: buildDeliveryUrl(filePath, { width }), alt: null };
}

/**
 * Build Webflow image fieldData from ImageKit file paths (ordered).
 */
function imageKitEndpointHost() {
  try {
    return new URL(process.env.IMAGEKIT_URL_ENDPOINT || "").host;
  } catch {
    return "ik.imagekit.io";
  }
}

function isImageKitCmsUrl(url) {
  if (!url) return false;
  const host = imageKitEndpointHost();
  return url.includes(host) || url.includes("ik.imagekit.io");
}

function galleryUrlsFromFieldData(fieldData) {
  const gallery = fieldData?.["image-gallery"];
  if (!Array.isArray(gallery)) return [];
  return gallery.map((g) => g?.url).filter(Boolean);
}

function cmsHasImageKitGallery(fieldData, sourceCount) {
  const urls = galleryUrlsFromFieldData(fieldData);
  if (!urls.length || urls.length !== sourceCount) return false;
  return urls.every(isImageKitCmsUrl);
}

function buildFilePathsForMachine(uniqueId, sourceUrls) {
  const folder = machineFolder(uniqueId);
  return sourceUrls.map((sourceUrl, i) => {
    const ext = fileExtensionFromUrl(sourceUrl);
    const fileName = `${uniqueId}-${String(i).padStart(2, "0")}.${ext}`;
    const root = folder.endsWith("/") ? folder.slice(0, -1) : folder;
    return `${root}/${fileName}`;
  });
}

async function uploadMachineImages(uniqueId, sourceUrls, { quiet = false } = {}) {
  const folder = machineFolder(uniqueId);
  const uploaded = [];

  for (let i = 0; i < sourceUrls.length; i++) {
    const sourceUrl = sourceUrls[i];
    const ext = fileExtensionFromUrl(sourceUrl);
    const fileName = `${uniqueId}-${String(i).padStart(2, "0")}.${ext}`;

    if (!quiet) {
      console.log(`  [${i + 1}/${sourceUrls.length}] upload ${fileName}`);
    }

    const result = await uploadFromUrl(sourceUrl, { fileName, folder });
    uploaded.push(result.filePath);
  }

  return uploaded;
}

function mapImageKitFields(filePaths, secondGalleryFieldSlug) {
  if (!filePaths.length) return {};
  const { primary, overflow } = splitForWebflowGalleries(filePaths);
  const out = {
    "image-gallery": primary.map((fp) => toWebflowImage(fp, "gallery")),
  };
  if (secondGalleryFieldSlug) {
    out[secondGalleryFieldSlug] = overflow.map((fp) => toWebflowImage(fp, "gallery"));
  }
  if (filePaths[0]) out.image1 = toWebflowImage(filePaths[0], "thumb");
  if (filePaths[1]) out.image2 = toWebflowImage(filePaths[1], "thumb");
  if (filePaths[2]) out.image3 = toWebflowImage(filePaths[2], "thumb");
  if (filePaths[3]) out.image4 = toWebflowImage(filePaths[3], "thumb");
  return out;
}

module.exports = {
  isImageKitEnabled,
  machineFolder,
  fileExtensionFromUrl,
  buildDeliveryUrl,
  uploadFromUrl,
  uploadMachineImages,
  mapImageKitFields,
  splitForWebflowGalleries,
  toWebflowImage,
  buildFilePathsForMachine,
  cmsHasImageKitGallery,
  isImageKitCmsUrl,
  galleryUrlsFromFieldData,
  WEBFLOW_GALLERY_MAX,
  MAX_IMAGES_CAP,
  GALLERY_WIDTH,
  THUMB_WIDTH,
  QUALITY,
  FORMAT,
};
