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

const SYNC_FIELD_KEYS = [
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
  "image-gallery-count",
  "image-first-url",
];

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
  const out = {
    "image-gallery": gallery,
    "image-gallery2-2": gallery,
  };
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

function normalizeSyncFields(fields) {
  const gallery = fields?.["image-gallery"];
  const urls = Array.isArray(gallery)
    ? gallery.map((g) => g?.url).filter(Boolean)
    : [];

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
    "image-gallery-count": urls.length,
    "image-first-url": urls[0] || "",
  };
}

function syncFieldsEqual(existingFieldData, incomingFields) {
  const a = normalizeSyncFields(existingFieldData);
  const b = normalizeSyncFields(incomingFields);
  return SYNC_FIELD_KEYS.every((key) => a[key] === b[key]);
}

module.exports = {
  SYNC_FIELD_KEYS,
  buildMachineFields,
  normalizeSyncFields,
  syncFieldsEqual,
  parseAdvertisedPrice,
  getImageUrls,
  isCloudinaryEnabled,
};
