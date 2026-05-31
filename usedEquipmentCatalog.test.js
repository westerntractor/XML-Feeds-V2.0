const test = require("assert");
const {
  buildCatalogMachines,
  queryUsedEquipment,
} = require("./usedEquipmentCatalog");

const sampleItems = [
  {
    id: "a1",
    isArchived: false,
    fieldData: {
      "unique-id": 1,
      name: "John Deere 8R 370",
      "category-text": "Tractor",
      "manufacturer-text": "John Deere",
      "model-text": "8R 370",
      "city-text": "Rosetown",
      "modelyear-text": "2022",
      "advertised-price-amount": 350000,
      "advertised-price-currency": "CAD",
      operationhours: 1200,
      "image-first-url": "https://example.com/a.jpg",
    },
  },
  {
    id: "a2",
    isArchived: false,
    fieldData: {
      "unique-id": 2,
      name: "John Deere X9 1000",
      "category-text": "Combine",
      "manufacturer-text": "John Deere",
      "model-text": "X9 1000",
      "city-text": "Kindersley",
      "modelyear-text": "2024",
      "advertised-price-amount": 900000,
      operationhours: 500,
    },
  },
  {
    id: "dup-old",
    isArchived: true,
    fieldData: { "unique-id": 1, name: "Old duplicate" },
  },
];

const machines = buildCatalogMachines(sampleItems);
test.strictEqual(machines.length, 2);

const filtered = queryUsedEquipment(machines, {
  category: "Combine",
  page: 1,
  limit: 12,
});
test.strictEqual(filtered.items.length, 1);
test.strictEqual(filtered.items[0].model, "X9 1000");
test.ok(filtered.filterOptions.makes.includes("John Deere"));
test.strictEqual(
  filtered.filterOptions.models.includes("8R 370"),
  false,
  "model list should respect category cascade"
);

console.log("usedEquipmentCatalog tests passed");
