const test = require("assert");
const {
  computeImageSourceFingerprint,
  feedImagesUnchanged,
  fingerprintFieldSlug,
  readStoredFingerprint,
} = require("./imageSourceFingerprint");

const urlsA = [
  "https://photos.machinefinder.com/a.jpg",
  "https://photos.machinefinder.com/b.jpg",
];
const urlsB = [
  "https://photos.machinefinder.com/b.jpg",
  "https://photos.machinefinder.com/a.jpg",
];

const fpA = computeImageSourceFingerprint(urlsA);
const fpB = computeImageSourceFingerprint(urlsB);

test.ok(fpA.length > 10, "fingerprint is non-empty base64");
test.notStrictEqual(fpA, fpB, "order-sensitive fingerprint");

const fieldData = { [fingerprintFieldSlug()]: fpA };
test.ok(feedImagesUnchanged(fieldData, urlsA));
test.strictEqual(readStoredFingerprint(fieldData), fpA);
test.ok(!feedImagesUnchanged(fieldData, urlsB));

console.log("imageSourceFingerprint tests passed");
