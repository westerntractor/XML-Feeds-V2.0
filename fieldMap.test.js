const test = require("assert");
const {
  buildMachineFields,
  buildSyncFieldsForUpdate,
  imagesSyncEqual,
  nonImageFieldsEqual,
  syncFieldsEqual,
} = require("./fieldMap");

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

const fields = buildMachineFields(machine);
const existing = { ...fields, "advertised-price-amount": 300000 };

test.ok(imagesSyncEqual(existing, fields), "same gallery urls => images equal");
test.strictEqual(
  nonImageFieldsEqual(existing, fields),
  false,
  "price differs => non-image not equal"
);

const patch = buildSyncFieldsForUpdate(existing, fields, machine);
test.ok(patch);
test.strictEqual(patch["advertised-price-amount"], 350000);
test.strictEqual(patch["image-gallery"], undefined, "must not include gallery when only price changed");

const unchanged = buildSyncFieldsForUpdate(fields, fields, machine);
test.strictEqual(unchanged, null);
test.ok(syncFieldsEqual(fields, fields));

console.log("fieldMap tests passed");
