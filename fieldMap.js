/** MachineFinder XML → Webflow CMS fieldData mapping */

const {
  isCloudinaryEnabled,
  optimizeImageUrl,
  GALLERY_WIDTH,
  THUMB_WIDTH,
} = require("./cloudinaryImages");

const MAX_IMAGES_PER_MACHINE = parseInt(
  process.env.CLOUDINARY_MAX_IMAGES_PER_MACHINE || "30",
  10
);

const SECOND_GALLERY_BY_COLLECTION = {
  "63090c9ea77ee20faacea709": "image-gallery2-2",
  "637cec1ebb30b75ef8186fd7": "image-gallery2",
};

function secondGalleryFieldSlug() {
  if (process.env.IMAGE_GALLERY2_FIELD) {
    return process.env.IMAGE_GALLERY2_FIELD.trim();
  }
  const collectionId = process.env.COLLECTION_ID || "";
  return SECOND_GALLERY_BY_COLLECTION[collectionId] || "image-gallery2-2";
}

const NON_IMAGE_SYNC_KEYS = [
  "name",
  "unique-id",
  "advertised-price-amount",
  "advertised-price-currency",
  "manufacturer-text",
  "model-text",
  "description",
  "stocknumber",
  "serialnumber",
  "category-text",
  "city-text",
  "modelyear-text",
  "state-province",
  "operationhours",
  "horsepower",
];

/** @deprecated use NON_IMAGE_SYNC_KEYS; kept for callers that import SYNC_FIELD_KEYS */
const SYNC_FIELD_KEYS = [...NON_IMAGE_SYNC_KEYS, "image-gallery-count", "image-first-url"];

const IMAGE_DATA_KEYS = ["image-gallery", "image1", "image2", "image3", "image4"];

function parseAdvertisedPrice(machine) {
  const ap = machine.advertised_price;
  if (ap != null && typeof ap === "object") {
    const amount = ap.amount ?? ap["#text"] ?? ap._;
    const currency = ap.currency ?? "CAD";
    return {
      amount: amount != null ? parseFloat(amount) : 0,
      currency: String(currency),
    };
  }
  if (ap != null) {
    return { amount: parseFloat(ap) || 0, currency: "CAD" };
  }
  const legacy = parseFloat(machine.price?.amount || 0) || 0;
  return { amount: legacy, currency: "CAD" };
}

function getImageUrls(machine) {
  let imgs = machine.images?.image;
  if (!imgs) return [];
  if (!Array.isArray(imgs)) imgs = [imgs];
  const sorted = [...imgs].sort(
    (a, b) => (b.primary === "true" ? 1 : 0) - (a.primary === "true" ? 1 : 0)
  );
  const urls = sorted
    .map((img) => img.filePointer || img.filePointerLarge)
    .filter(Boolean);
  return urls.slice(0, MAX_IMAGES_PER_MACHINE);
}

function toWebflowImage(sourceUrl, role = "gallery") {
  const width = role === "thumb" ? THUMB_WIDTH : GALLERY_WIDTH;
  const url = optimizeImageUrl(sourceUrl, { width });
  return { url, alt: null };
}

function mapImages(urls) {
  if (!urls.length) return {};
  const gallery = urls.map((u) => toWebflowImage(u, "gallery"));
  const out = { "image-gallery": gallery };
  const secondGallery = secondGalleryFieldSlug();
  if (secondGallery) out[secondGallery] = gallery;
  if (urls[0]) out.image1 = toWebflowImage(urls[0], "thumb");
  if (urls[1]) out.image2 = toWebflowImage(urls[1], "thumb");
  if (urls[2]) out.image3 = toWebflowImage(urls[2], "thumb");
  if (urls[3]) out.image4 = toWebflowImage(urls[3], "thumb");
  return out;
}

function categoryText(category) {
  const s = String(category ?? "").trim();
  if (!s) return "";
  return s.replace(/s$/i, "");
}

function buildMachineFields(machine) {
  const machineId = machine.id?.toString();
  const name = `${machine.manufacturer || ""} ${machine.model || ""}`.trim();
  const { amount, currency } = parseAdvertisedPrice(machine);
  const imageUrls = getImageUrls(machine);

  return {
    name,
    "unique-id": parseInt(machineId, 10),
    "advertised-price-amount": amount,
    "advertised-price-currency": currency,
    "manufacturer-text": String(machine.manufacturer ?? "N/A"),
    "model-text": String(machine.model ?? "N/A"),
    description: String(machine.description ?? "").trim(),
    stocknumber: String(machine.stockNumber ?? ""),
    serialnumber: String(machine.serialNumber ?? ""),
    "category-text": categoryText(machine.category),
    "city-text": String(machine.city ?? "").trim(),
    "modelyear-text": String(machine.modelYear ?? ""),
    "state-province": String(machine.state_province ?? ""),
    operationhours: parseFloat(machine.operationHours || 0) || 0,
    horsepower: String(machine.horsePower ?? "").trim(),
    ...mapImages(imageUrls),
  };
}

function normalizeNonImageFields(fields) {
  return {
    name: String(fields?.name || "").trim(),
    "unique-id": Number(fields?.["unique-id"]),
    "advertised-price-amount": Number(fields?.["advertised-price-amount"]) || 0,
    "advertised-price-currency": String(fields?.["advertised-price-currency"] ?? ""),
    "manufacturer-text": String(fields?.["manufacturer-text"] ?? "N/A"),
    "model-text": String(fields?.["model-text"] ?? "N/A"),
    description: String(fields?.description ?? "").trim(),
    stocknumber: String(fields?.stocknumber ?? ""),
    serialnumber: String(fields?.serialnumber ?? ""),
    "category-text": String(fields?.["category-text"] ?? ""),
    "city-text": String(fields?.["city-text"] ?? ""),
    "modelyear-text": String(fields?.["modelyear-text"] ?? ""),
    "state-province": String(fields?.["state-province"] ?? ""),
    operationhours: Number(fields?.operationhours) || 0,
    horsepower: String(fields?.horsepower ?? "").trim(),
  };
}

function galleryUrls(fields) {
  const gallery = fields?.["image-gallery"];
  return Array.isArray(gallery)
    ? gallery.map((g) => g?.url || "").filter(Boolean)
    : [];
}

/** Stable fingerprint of all image-bearing CMS fields (incl. Cloudinary URLs). */
function imageGalleryFingerprint(fields) {
  if (!fields) return "";
  const main = galleryUrls(fields).join("\n");
  const secondSlug = secondGalleryFieldSlug();
  const second = secondSlug
    ? (Array.isArray(fields[secondSlug])
        ? fields[secondSlug].map((g) => g?.url || "").filter(Boolean)
        : []
      ).join("\n")
    : "";
  const thumbs = IMAGE_DATA_KEYS.filter((k) => k !== "image-gallery")
    .map((k) => fields[k]?.url || "")
    .join(",");
  return `${main}|${second}|${thumbs}`;
}

function pickImageFieldData(fields) {
  if (!fields) return {};
  const out = {};
  if (fields["image-gallery"]) out["image-gallery"] = fields["image-gallery"];
  const secondSlug = secondGalleryFieldSlug();
  if (secondSlug && fields[secondSlug]) out[secondSlug] = fields[secondSlug];
  for (const key of IMAGE_DATA_KEYS) {
    if (key !== "image-gallery" && fields[key]) out[key] = fields[key];
  }
  return out;
}

function imagesSyncEqual(existingFieldData, incomingFields) {
  return (
    imageGalleryFingerprint(existingFieldData) ===
    imageGalleryFingerprint(incomingFields)
  );
}

function nonImageFieldsEqual(existingFieldData, incomingFields) {
  const a = normalizeNonImageFields(existingFieldData);
  const b = normalizeNonImageFields(incomingFields);
  return NON_IMAGE_SYNC_KEYS.every((key) => a[key] === b[key]);
}

/**
 * Build minimal fieldData for a Webflow PATCH.
 * Returns null when nothing changed.
 * Omits image fields when only metadata changed (avoids new Cloudinary transforms).
 */
function buildSyncFieldsForUpdate(existingFieldData, incomingFields) {
  const imagesChanged = !imagesSyncEqual(existingFieldData, incomingFields);
  const nonImageChanged = !nonImageFieldsEqual(existingFieldData, incomingFields);

  if (!imagesChanged && !nonImageChanged) return null;

  const patch = {};
  if (nonImageChanged) {
    const normalized = normalizeNonImageFields(incomingFields);
    for (const key of NON_IMAGE_SYNC_KEYS) {
      patch[key] = incomingFields[key] ?? normalized[key];
    }
  }
  if (imagesChanged) {
    Object.assign(patch, pickImageFieldData(incomingFields));
  }
  return patch;
}

function normalizeSyncFields(fields) {
  const urls = galleryUrls(fields);
  return {
    ...normalizeNonImageFields(fields),
    "image-gallery-count": urls.length,
    "image-first-url": urls[0] || "",
  };
}

function syncFieldsEqual(existingFieldData, incomingFields) {
  return (
    nonImageFieldsEqual(existingFieldData, incomingFields) &&
    imagesSyncEqual(existingFieldData, incomingFields)
  );
}

module.exports = {
  SYNC_FIELD_KEYS,
  NON_IMAGE_SYNC_KEYS,
  IMAGE_DATA_KEYS,
  buildMachineFields,
  buildSyncFieldsForUpdate,
  normalizeSyncFields,
  normalizeNonImageFields,
  imagesSyncEqual,
  nonImageFieldsEqual,
  syncFieldsEqual,
  pickImageFieldData,
  parseAdvertisedPrice,
  getImageUrls,
  isCloudinaryEnabled,
};
