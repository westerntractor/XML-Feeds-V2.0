const test = require("assert");
const {
  mapImageKitFields,
  splitForWebflowGalleries,
  WEBFLOW_GALLERY_MAX,
  MAX_IMAGES_CAP,
} = require("./imagekitImages");

test.strictEqual(WEBFLOW_GALLERY_MAX, 25);
test.strictEqual(MAX_IMAGES_CAP, 50);

const paths32 = Array.from({ length: 32 }, (_, i) => `/western-sales/11581730/11581730-${String(i).padStart(2, "0")}.jpg`);

const split = splitForWebflowGalleries(paths32);
test.strictEqual(split.primary.length, 25);
test.strictEqual(split.overflow.length, 7);

const fields = mapImageKitFields(paths32, "image-gallery2");
test.strictEqual(fields["image-gallery"].length, 25);
test.strictEqual(fields["image-gallery2"].length, 7);

const paths10 = paths32.slice(0, 10);
const fields10 = mapImageKitFields(paths10, "image-gallery2");
test.strictEqual(fields10["image-gallery"].length, 10);
test.strictEqual(fields10["image-gallery2"].length, 0);

console.log("imagekitImages tests passed");
