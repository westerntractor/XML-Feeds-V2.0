/**
 * Verbose image-sync diagnostics. Enable with IMAGE_SYNC_DEBUG=true (or 1).
 */

const {
  galleryUrlsFromFieldData,
  isImageKitCmsUrl,
  buildDeliveryUrl,
} = require("./imagekitImages");

function imageKitEndpointHost() {
  try {
    return new URL(process.env.IMAGEKIT_URL_ENDPOINT || "").host;
  } catch {
    return "ik.imagekit.io";
  }
}

function isImageSyncDebug() {
  const v = process.env.IMAGE_SYNC_DEBUG;
  return v === "true" || v === "1";
}

function log(section, message, detail) {
  if (!isImageSyncDebug()) return;
  const prefix = `[IMAGE_SYNC_DEBUG][${section}]`;
  if (detail === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  if (typeof detail === "string") {
    console.log(`${prefix} ${message} ${detail}`);
    return;
  }
  console.log(`${prefix} ${message}`, JSON.stringify(detail, null, 2));
}

function secondGallerySlug() {
  if (process.env.IMAGE_GALLERY2_FIELD) {
    return process.env.IMAGE_GALLERY2_FIELD.trim();
  }
  const byCollection = {
    "63090c9ea77ee20faacea709": "image-gallery2-2",
    "637cec1ebb30b75ef8186fd7": "image-gallery2",
  };
  return byCollection[process.env.COLLECTION_ID || ""] || "image-gallery2-2";
}

function galleryUrlList(fieldData) {
  return galleryUrlsFromFieldData(fieldData);
}

function thumbUrls(fieldData) {
  return {
    image1: fieldData?.image1?.url || "",
    image2: fieldData?.image2?.url || "",
    image3: fieldData?.image3?.url || "",
    image4: fieldData?.image4?.url || "",
  };
}

function diagnoseCmsImageKitGallery(fieldData, sourceCount) {
  const result = {
    ok: false,
    sourceCount,
    cmsCount: 0,
    reasons: [],
    firstCmsUrl: null,
    nonImageKitSamples: [],
    galleryType: fieldData?.["image-gallery"]
      ? Array.isArray(fieldData["image-gallery"])
        ? "array"
        : typeof fieldData["image-gallery"]
      : "missing",
  };

  if (!fieldData) {
    result.reasons.push("existingFieldData is null/undefined");
    return result;
  }

  const urls = galleryUrlList(fieldData);
  result.cmsCount = urls.length;
  result.firstCmsUrl = urls[0] || null;

  if (!Array.isArray(fieldData["image-gallery"])) {
    result.reasons.push(
      `image-gallery is not an array (type=${result.galleryType})`
    );
  }
  if (!urls.length) {
    result.reasons.push("image-gallery has zero URLs");
  }
  if (urls.length && urls.length !== sourceCount) {
    result.reasons.push(
      `count mismatch: cms=${urls.length} feed=${sourceCount}`
    );
  }

  const nonIk = urls.filter((u) => !isImageKitCmsUrl(u));
  if (nonIk.length) {
    result.reasons.push(`${nonIk.length} URL(s) are not ImageKit`);
    result.nonImageKitSamples = nonIk.slice(0, 3);
  }

  result.ok = result.reasons.length === 0;
  return result;
}

function firstUrlMismatch(existingUrls, incomingUrls) {
  const max = Math.max(existingUrls.length, incomingUrls.length);
  for (let i = 0; i < max; i++) {
    const a = existingUrls[i] || "(missing)";
    const b = incomingUrls[i] || "(missing)";
    if (a !== b) {
      return { index: i, existing: a, incoming: b };
    }
  }
  return null;
}

function diagnoseImageFields(existingFieldData, incomingFields) {
  const secondSlug = secondGallerySlug();
  const existingMain = galleryUrlList(existingFieldData);
  const incomingMain = galleryUrlList(incomingFields);
  const existingSecond = Array.isArray(existingFieldData?.[secondSlug])
    ? existingFieldData[secondSlug].map((g) => g?.url || "").filter(Boolean)
    : [];
  const incomingSecond = Array.isArray(incomingFields?.[secondSlug])
    ? incomingFields[secondSlug].map((g) => g?.url || "").filter(Boolean)
    : [];
  const existingThumbs = thumbUrls(existingFieldData || {});
  const incomingThumbs = thumbUrls(incomingFields || {});

  const mainMismatch = firstUrlMismatch(existingMain, incomingMain);
  const secondMismatch = firstUrlMismatch(existingSecond, incomingSecond);
  const thumbMismatches = Object.keys(existingThumbs).filter(
    (k) => existingThumbs[k] !== incomingThumbs[k]
  );

  return {
    secondGalleryField: secondSlug,
    mainGallery: {
      existingCount: existingMain.length,
      incomingCount: incomingMain.length,
      equal: existingMain.join("\n") === incomingMain.join("\n"),
      firstMismatch: mainMismatch,
    },
    secondGallery: {
      existingCount: existingSecond.length,
      incomingCount: incomingSecond.length,
      equal: existingSecond.join("\n") === incomingSecond.join("\n"),
      firstMismatch: secondMismatch,
    },
    thumbs: {
      equal: thumbMismatches.length === 0,
      mismatchedKeys: thumbMismatches,
      samples: thumbMismatches.slice(0, 2).map((k) => ({
        key: k,
        existing: existingThumbs[k],
        incoming: incomingThumbs[k],
      })),
    },
  };
}

function logEnvSnapshot(section = "env") {
  if (!isImageSyncDebug()) return;
  log(section, "runtime config", {
    COLLECTION_ID: process.env.COLLECTION_ID,
    IMAGEKIT_UPLOAD_FOLDER: process.env.IMAGEKIT_UPLOAD_FOLDER,
    IMAGEKIT_URL_ENDPOINT: process.env.IMAGEKIT_URL_ENDPOINT,
    IMAGEKIT_QUALITY: process.env.IMAGEKIT_QUALITY || "60",
    IMAGEKIT_GALLERY_WIDTH: process.env.IMAGEKIT_GALLERY_WIDTH || "1200",
    IMAGEKIT_THUMB_WIDTH: process.env.IMAGEKIT_THUMB_WIDTH || "800",
    IMAGEKIT_FORMAT: process.env.IMAGEKIT_FORMAT || "avif",
    IMAGEKIT_MAX_IMAGES:
      process.env.IMAGEKIT_MAX_IMAGES_PER_MACHINE ||
      process.env.CLOUDINARY_MAX_IMAGES_PER_MACHINE ||
      "50",
    IMAGEKIT_ENABLED: Boolean(
      process.env.IMAGEKIT_API_KEY && process.env.IMAGEKIT_URL_ENDPOINT
    ),
    IMAGEKIT_ENDPOINT_HOST: imageKitEndpointHost(),
    SECOND_GALLERY_FIELD: secondGallerySlug(),
    HEROKU_APP_URL: process.env.HEROKU_APP_URL,
    CLOUDINARY_ENABLED: process.env.CLOUDINARY_ENABLED,
  });
}

function logInventorySummary(fieldsByUniqueId, inventoryMap) {
  if (!isImageSyncDebug()) return;
  const keys = Object.keys(fieldsByUniqueId || {});
  const mapKeys = Object.keys(inventoryMap || {});
  const withGallery = keys.filter(
    (k) => galleryUrlList(fieldsByUniqueId[k]).length > 0
  );
  const withImageKit = keys.filter((k) => {
    const urls = galleryUrlList(fieldsByUniqueId[k]);
    return urls.length > 0 && urls.every(isImageKitCmsUrl);
  });
  const sampleKey = withGallery[0] || keys[0];
  const sample = sampleKey ? fieldsByUniqueId[sampleKey] : null;

  log("inventory", "summary", {
    fieldsByUniqueIdCount: keys.length,
    inventoryMapCount: mapKeys.length,
    withGalleryCount: withGallery.length,
    withAllImageKitUrlsCount: withImageKit.length,
    sampleUniqueId: sampleKey,
    sampleGalleryCount: sample ? galleryUrlList(sample).length : 0,
    sampleFirstUrl: sample ? galleryUrlList(sample)[0] : null,
    fieldsByUniqueIdHasMapWrapper: true,
  });
}

function logMachineLookup(machineId, inventoryMap, fieldsByUniqueId) {
  if (!isImageSyncDebug()) return;
  const key = String(machineId);
  const altKey = String(parseInt(machineId, 10));
  log("lookup", `machineId=${key}`, {
    inInventoryMap: Boolean(inventoryMap?.[key] || inventoryMap?.[altKey]),
    inventoryItemId: inventoryMap?.[key] || inventoryMap?.[altKey] || null,
    hasFieldsByUniqueId: Boolean(fieldsByUniqueId?.[key]),
    fieldsKeysTried: [key, altKey],
    fieldsByUniqueIdKeyCount: Object.keys(fieldsByUniqueId || {}).length,
  });
}

function logBuildMachineFieldsResult(uniqueId, {
  sourceCount,
  cmsDiagnosis,
  canSkipUpload,
  didUpload,
  sampleIncomingUrl,
  sampleExistingUrl,
  sampleRebuiltPath,
}) {
  if (!isImageSyncDebug()) return;
  log("buildMachineFields", `unique-id=${uniqueId}`, {
    feedImageCount: sourceCount,
    canSkipUpload,
    didUpload,
    cmsDiagnosis,
    sampleExistingUrl,
    sampleIncomingUrl,
    sampleRebuiltPath,
    sampleRebuiltDeliveryUrl: sampleRebuiltPath
      ? buildDeliveryUrl(sampleRebuiltPath, {
          width: parseInt(process.env.IMAGEKIT_GALLERY_WIDTH || "1200", 10),
        })
      : null,
  });
}

function logSyncDecision(machineId, name, {
  hasExistingFields,
  imagesEqual,
  metaEqual,
  syncEqual,
  imageDiagnosis,
}) {
  if (!isImageSyncDebug()) return;
  log("syncDecision", `${machineId} ${name}`, {
    hasExistingFields,
    imagesEqual,
    metaEqual,
    syncEqual,
    willPatch: !syncEqual,
    imageDiagnosis,
  });
}

function logServerPatch(uniqueId, name, itemId, {
  imagesChanged,
  metaChanged,
  updateKind,
  patchKeys,
  imageDiagnosis,
}) {
  if (!isImageSyncDebug()) return;
  log("serverPatch", `${uniqueId} ${name} (${itemId})`, {
    imagesChanged,
    metaChanged,
    updateKind,
    patchFieldKeys: patchKeys,
    imageDiagnosis,
  });
}

module.exports = {
  isImageSyncDebug,
  log,
  logEnvSnapshot,
  diagnoseCmsImageKitGallery,
  diagnoseImageFields,
  logInventorySummary,
  logMachineLookup,
  logBuildMachineFieldsResult,
  logSyncDecision,
  logServerPatch,
  secondGallerySlug,
};
