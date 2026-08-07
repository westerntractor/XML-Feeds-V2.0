const test = require("assert");
const {
  mapImageKitFields,
  splitForWebflowGalleries,
  buildDeliveryUrl,
  WEBFLOW_GALLERY_MAX,
  MAX_IMAGES_CAP,
  GALLERY_WIDTH,
  QUALITY,
  FORMAT,
} = require("./imagekitImages");

test.strictEqual(WEBFLOW_GALLERY_MAX, 25);
test.strictEqual(MAX_IMAGES_CAP, 50);
test.strictEqual(GALLERY_WIDTH, 1200);
test.strictEqual(QUALITY, 60);
test.strictEqual(FORMAT, "avif");

process.env.IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/websitewt";
const delivery = buildDeliveryUrl("/western-tractor/11097515/11097515-00.jpg", {
  width: 1200,
});
test.ok(
  delivery.includes("/tr:w-1200,q-60,f-avif/"),
  `expected avif transform URL, got ${delivery}`
);

const paths32 = Array.from({ length: 32 }, (_, i) => `/western-sales/11581730/11581730-${String(i).padStart(2, "0")}.jpg`);

const split = splitForWebflowGalleries(paths32);
test.strictEqual(split.primary.length, 25);
test.strictEqual(split.overflow.length, 7);

const fields = mapImageKitFields(paths32, "image-gallery2");
test.strictEqual(fields["image-gallery"].length, 25);
test.strictEqual(fields["image-gallery2"].length, 7);
test.ok(
  fields["image-gallery"][0].url.includes("f-avif"),
  "gallery URLs use f-avif"
);

const paths10 = paths32.slice(0, 10);
const fields10 = mapImageKitFields(paths10, "image-gallery2");
test.strictEqual(fields10["image-gallery"].length, 10);
test.strictEqual(fields10["image-gallery2"].length, 0);

console.log("imagekitImages tests passed");
