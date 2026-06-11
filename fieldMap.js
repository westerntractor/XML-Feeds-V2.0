/** MachineFinder XML → Webflow CMS fieldData mapping */

const {
  isImageKitEnabled,
  mapImageKitFields,
  uploadMachineImages,
} = require("./imagekitImages");
const {
  isImageSyncDebug,
  log: debugLog,
} = require("./imageSyncDebug");
const {
  fingerprintFieldSlug,
  computeImageSourceFingerprint,
  readStoredFingerprint,
  feedImagesUnchanged,
} = require("./imageSourceFingerprint");

const MAX_IMAGES_PER_MACHINE = parseInt(
  process.env.IMAGEKIT_MAX_IMAGES_PER_MACHINE ||
    process.env.CLOUDINARY_MAX_IMAGES_PER_MACHINE ||
    "30",
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
    .map((img) => img.filePointerLarge || img.filePointer)
    .filter(Boolean);
  return urls.slice(0, MAX_IMAGES_PER_MACHINE);
}

function mapImagesRaw(urls) {
  if (!urls.length) return {};
  const toImage = (url) => ({ url, alt: null });
  const gallery = urls.map((u) => toImage(u));
  const out = { "image-gallery": gallery };
  const secondGallery = secondGalleryFieldSlug();
  if (secondGallery) out[secondGallery] = gallery;
  if (urls[0]) out.image1 = toImage(urls[0]);
  if (urls[1]) out.image2 = toImage(urls[1]);
  if (urls[2]) out.image3 = toImage(urls[2]);
  if (urls[3]) out.image4 = toImage(urls[3]);
  return out;
}

function withFingerprint(fields, sourceUrls) {
  const slug = fingerprintFieldSlug();
  const fp = computeImageSourceFingerprint(sourceUrls);
  if (!fp) return fields;
  return { ...fields, [slug]: fp };
}

function buildMachineFieldsBase(machine) {
  const machineId = machine.id?.toString();
  const name = `${machine.manufacturer || ""} ${machine.model || ""}`.trim();
  const { amount, currency } = parseAdvertisedPrice(machine);

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
  };
}

function categoryText(category) {
  const s = String(category ?? "").trim();
  if (!s) return "";
  return s.replace(/s$/i, "");
}

/** Sync fields with raw feed image URLs (no ImageKit). Used in tests. */
function buildMachineFields(machine) {
  const imageUrls = getImageUrls(machine);
  return withFingerprint(
    {
      ...buildMachineFieldsBase(machine),
      ...mapImagesRaw(imageUrls),
    },
    imageUrls
  );
}

/**
 * Build full CMS fields for sync.
 * Skips ImageKit upload when feed fingerprint matches CMS image_source_fingerprint.
 */
async function buildMachineFieldsAsync(machine, existingFieldData = null) {
  const base = buildMachineFieldsBase(machine);
  const sourceUrls = getImageUrls(machine);

  if (!sourceUrls.length) {
    if (isImageSyncDebug()) {
      debugLog("buildMachineFields", `unique-id=${machine.id} no feed images`);
    }
    return base;
  }

  const feedFingerprint = computeImageSourceFingerprint(sourceUrls);
  const slug = fingerprintFieldSlug();
  const skipImages = feedImagesUnchanged(existingFieldData, sourceUrls);

  if (isImageSyncDebug()) {
    debugLog("buildMachineFields", `unique-id=${machine.id}`, {
      feedFingerprint: feedFingerprint.slice(0, 16) + "...",
      storedFingerprint: (readStoredFingerprint(existingFieldData) || "(empty)").slice(
        0,
        16
      ),
      feedImageCount: sourceUrls.length,
      skipImages,
      willUpload: !skipImages && isImageKitEnabled(),
    });
  }

  if (skipImages) {
    return { ...base, [slug]: feedFingerprint };
  }

  if (!isImageKitEnabled()) {
    return withFingerprint(
      { ...base, ...mapImagesRaw(sourceUrls) },
      sourceUrls
    );
  }

  const uniqueId = String(machine.id);
  const secondGallery = secondGalleryFieldSlug();

  if (isImageSyncDebug()) {
    debugLog(
      "buildMachineFields",
      `unique-id=${uniqueId} uploading ${sourceUrls.length} images to ImageKit`
    );
  }

  const filePaths = await uploadMachineImages(uniqueId, sourceUrls, {
    quiet: !isImageSyncDebug(),
  });
  const imageFields = mapImageKitFields(filePaths, secondGallery);

  return { ...base, ...imageFields, [slug]: feedFingerprint };
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

/** @deprecated gallery URL comparison; use fingerprint via imagesSyncEqual */
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
  const fpSlug = fingerprintFieldSlug();
  if (fields[fpSlug]) out[fpSlug] = fields[fpSlug];
  return out;
}

function imagesSyncEqual(existingFieldData, incomingFields) {
  const slug = fingerprintFieldSlug();
  const existingFp = readStoredFingerprint(existingFieldData);
  const incomingFp = String(incomingFields?.[slug] ?? "").trim();

  if (existingFp && incomingFp) {
    const equal = existingFp === incomingFp;
    if (isImageSyncDebug() && !equal) {
      debugLog("imagesSyncEqual", "fingerprint mismatch", {
        uniqueId: incomingFields?.["unique-id"],
        existingFp: existingFp.slice(0, 20),
        incomingFp: incomingFp.slice(0, 20),
      });
    }
    return equal;
  }

  // Legacy items without fingerprint field — fall back to gallery URL compare
  const legacyEqual =
    imageGalleryFingerprint(existingFieldData) ===
    imageGalleryFingerprint(incomingFields);
  if (isImageSyncDebug() && !legacyEqual) {
    debugLog("imagesSyncEqual", "legacy gallery URL mismatch (no fingerprint)", {
      uniqueId: incomingFields?.["unique-id"],
      hasExistingFp: Boolean(existingFp),
      hasIncomingFp: Boolean(incomingFp),
    });
  }
  return legacyEqual;
}

function nonImageFieldsEqual(existingFieldData, incomingFields) {
  const a = normalizeNonImageFields(existingFieldData);
  const b = normalizeNonImageFields(incomingFields);
  const equal = NON_IMAGE_SYNC_KEYS.every((key) => a[key] === b[key]);
  if (isImageSyncDebug() && !equal) {
    const changed = NON_IMAGE_SYNC_KEYS.filter((key) => a[key] !== b[key]).map(
      (key) => ({ key, existing: a[key], incoming: b[key] })
    );
    debugLog(
      "nonImageFieldsEqual",
      `unique-id=${incomingFields?.["unique-id"] ?? existingFieldData?.["unique-id"]} metadata differs`,
      changed
    );
  }
  return equal;
}

/**
 * Build minimal fieldData for a Webflow PATCH.
 * Returns null when nothing changed.
 * Omits image fields when only metadata changed.
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

function imageProviderLabel(sampleUrl) {
  if (!sampleUrl) return "none";
  if (sampleUrl.includes("ik.imagekit.io")) return "imagekit";
  if (sampleUrl.includes("website-files.com")) return "webflow-cdn";
  return "direct";
}

module.exports = {
  SYNC_FIELD_KEYS,
  NON_IMAGE_SYNC_KEYS,
  IMAGE_DATA_KEYS,
  buildMachineFields,
  buildMachineFieldsAsync,
  buildSyncFieldsForUpdate,
  normalizeSyncFields,
  normalizeNonImageFields,
  imagesSyncEqual,
  nonImageFieldsEqual,
  syncFieldsEqual,
  pickImageFieldData,
  parseAdvertisedPrice,
  getImageUrls,
  secondGalleryFieldSlug,
  isImageKitEnabled,
  imageProviderLabel,
  fingerprintFieldSlug,
};
