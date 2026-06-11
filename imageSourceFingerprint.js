const crypto = require("crypto");

// Webflow slug (hyphens); display name in CMS may show underscores.
const DEFAULT_FIELD_SLUG = "image-source-fingerprint";

function fingerprintFieldSlug() {
  const fromEnv = process.env.IMAGE_SOURCE_FINGERPRINT_FIELD;
  if (fromEnv && String(fromEnv).trim()) {
    return String(fromEnv).trim();
  }
  return DEFAULT_FIELD_SLUG;
}

/**
 * Stable hash of ordered feed image URLs (same order as getImageUrls).
 * @param {string[]} sourceUrls
 * @returns {string} base64-encoded SHA-256
 */
function computeImageSourceFingerprint(sourceUrls) {
  if (!sourceUrls?.length) return "";
  const payload = sourceUrls.join("\n");
  return crypto.createHash("sha256").update(payload, "utf8").digest("base64");
}

function computeFingerprintFromMachine(machine, getImageUrls) {
  const urls = getImageUrls(machine);
  return computeImageSourceFingerprint(urls);
}

function readStoredFingerprint(fieldData) {
  const slug = fingerprintFieldSlug();
  return String(fieldData?.[slug] ?? "").trim();
}

function feedImagesUnchanged(existingFieldData, sourceUrls) {
  if (!sourceUrls.length) return true;
  const stored = readStoredFingerprint(existingFieldData);
  if (!stored) return false;
  return stored === computeImageSourceFingerprint(sourceUrls);
}

module.exports = {
  fingerprintFieldSlug,
  computeImageSourceFingerprint,
  computeFingerprintFromMachine,
  readStoredFingerprint,
  feedImagesUnchanged,
  DEFAULT_FIELD_SLUG,
};
