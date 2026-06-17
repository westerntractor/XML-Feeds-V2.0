const test = require("assert");
const {
  buildMachineFields,
  buildSyncFieldsForUpdate,
  imagesSyncEqual,
  nonImageFieldsEqual,
  syncFieldsEqual,
  getImageUrls,
  cmsGalleryLayoutMatches,
  expectedGalleryCounts,
} = require("./fieldMap");
const {
  computeImageSourceFingerprint,
  fingerprintFieldSlug,
} = require("./imageSourceFingerprint");

const machine = {
  id: "100",
  manufacturer: "John Deere",
  model: "8R 370",
  category: "Tractors",
  city: "Rosetown",
  modelYear: "2022",
  operationHours: 100,
  advertised_price: { amount: 350000, currency: "CAD" },
  images: {
    image: [
      { filePointer: "https://cdn.example.com/a.jpg", primary: "true" },
      { filePointer: "https://cdn.example.com/b.jpg" },
    ],
  },
};

const slug = fingerprintFieldSlug();
const urls = getImageUrls(machine);
const fp = computeImageSourceFingerprint(urls);
const fields = buildMachineFields(machine);
const existing = { ...fields, "advertised-price-amount": 300000 };

test.strictEqual(fields[slug], fp, "buildMachineFields sets fingerprint");

test.ok(imagesSyncEqual(existing, fields), "same fingerprint => images equal");
test.strictEqual(
  nonImageFieldsEqual(existing, fields),
  false,
  "price differs => non-image not equal"
);

const patch = buildSyncFieldsForUpdate(existing, fields);
test.ok(patch);
test.strictEqual(patch["advertised-price-amount"], 350000);
test.strictEqual(patch["image-gallery"], undefined, "must not include gallery when only price changed");

const unchanged = buildSyncFieldsForUpdate(fields, fields);
test.strictEqual(unchanged, null);
test.ok(syncFieldsEqual(fields, fields));

const metaOnly = {
  name: fields.name,
  "unique-id": fields["unique-id"],
  "advertised-price-amount": fields["advertised-price-amount"],
  "advertised-price-currency": fields["advertised-price-currency"],
  "manufacturer-text": fields["manufacturer-text"],
  "model-text": fields["model-text"],
  description: fields.description,
  stocknumber: fields.stocknumber,
  serialnumber: fields.serialnumber,
  "category-text": fields["category-text"],
  "city-text": fields["city-text"],
  "modelyear-text": fields["modelyear-text"],
  "state-province": fields["state-province"],
  operationhours: fields.operationhours,
  horsepower: fields.horsepower,
};
const incomingSkip = { ...metaOnly, [slug]: fp };
const existingWebflow = {
  ...metaOnly,
  "image-gallery": [{ url: "https://cdn.prod.website-files.com/old.jpeg", alt: null }],
  [slug]: fp,
};
test.ok(
  imagesSyncEqual(existingWebflow, incomingSkip),
  "fingerprint match ignores different CMS gallery URLs"
);
test.ok(
  syncFieldsEqual(existingWebflow, incomingSkip),
  "unchanged when fingerprint matches even if CMS URLs differ"
);

const manyUrls = Array.from({ length: 32 }, (_, i) => `https://cdn.example.com/img-${i}.jpg`);
const splitFields = buildMachineFields({
  ...machine,
  images: { image: manyUrls.map((url, i) => ({ filePointer: url, primary: i === 0 ? "true" : undefined })) },
});
test.strictEqual(splitFields["image-gallery"].length, 25);
test.strictEqual(splitFields["image-gallery2-2"].length, 7);

const counts = expectedGalleryCounts(32);
test.strictEqual(counts.primary, 25);
test.strictEqual(counts.overflow, 7);

const legacyDupCms = {
  "image-gallery": Array.from({ length: 25 }, (_, i) => ({ url: `https://cdn.prod.website-files.com/a-${i}.jpg`, alt: null })),
  "image-gallery2-2": Array.from({ length: 25 }, (_, i) => ({ url: `https://cdn.prod.website-files.com/a-${i}.jpg`, alt: null })),
  [slug]: computeImageSourceFingerprint(manyUrls),
};
test.ok(!cmsGalleryLayoutMatches(legacyDupCms, manyUrls), "legacy duplicate galleries fail layout check");

const fixedIncoming = { ...splitFields };
test.ok(
  !imagesSyncEqual(legacyDupCms, fixedIncoming),
  "fingerprint match but wrong layout => images not equal"
);

console.log("fieldMap tests passed");
