const { v2: cloudinary } = require("cloudinary");

let configured = false;

function isCloudinaryEnabled() {
  if (process.env.CLOUDINARY_ENABLED === "false") return false;
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );
}

function ensureConfigured() {
  if (configured || !isCloudinaryEnabled()) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

const GALLERY_WIDTH = parseInt(process.env.CLOUDINARY_GALLERY_WIDTH || "1600", 10);
const THUMB_WIDTH = parseInt(process.env.CLOUDINARY_THUMB_WIDTH || "800", 10);

/**
 * Signed fetch URL — unsigned fetch returns 401 on this account.
 */
function optimizeImageUrl(sourceUrl, { width = GALLERY_WIDTH } = {}) {
  if (!sourceUrl) return sourceUrl;
  if (!isCloudinaryEnabled()) return sourceUrl;

  ensureConfigured();
  return cloudinary.url(sourceUrl, {
    type: "fetch",
    secure: true,
    sign_url: true,
    transformation: [
      { width, crop: "limit", quality: "auto", fetch_format: "auto" },
    ],
  });
}

module.exports = {
  isCloudinaryEnabled,
  optimizeImageUrl,
  GALLERY_WIDTH,
  THUMB_WIDTH,
};
