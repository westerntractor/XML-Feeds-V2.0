/** Used equipment catalog: normalize CMS items, filter, paginate, cascade options. */

const CACHE_TTL_MS = 2 * 60 * 1000;

let catalogCache = null;
let catalogCacheAt = 0;

function parseNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b))
  );
}

function pickKeeper(candidates) {
  const active = candidates.filter((item) => !item.isArchived);
  const pool = active.length ? active : candidates;
  return pool.sort(
    (a, b) =>
      new Date(b.lastUpdated || 0).getTime() -
      new Date(a.lastUpdated || 0).getTime()
  )[0];
}

function imageUrl(fieldData) {
  const first = fieldData?.["image-first-url"];
  if (first) return first;
  const img1 = fieldData?.image1;
  if (typeof img1 === "string") return img1;
  if (img1?.url) return img1.url;
  const gallery = fieldData?.["image-gallery"];
  if (Array.isArray(gallery) && gallery[0]?.url) return gallery[0].url;
  return "";
}

function machineFromItem(item) {
  const f = item.fieldData || {};
  const uniqueId = f["unique-id"];
  if (uniqueId == null) return null;

  const price = Number(f["advertised-price-amount"]) || 0;
  const year = parseNumber(f["modelyear-text"]) || 0;

  return {
    itemId: item.id,
    uniqueId: Number(uniqueId),
    name: String(f.name || "").trim(),
    category: String(f["category-text"] || "").trim(),
    make: String(f["manufacturer-text"] || "").trim(),
    model: String(f["model-text"] || "").trim(),
    location: String(f["city-text"] || "").trim(),
    year,
    price,
    currency: String(f["advertised-price-currency"] || "CAD").trim(),
    hours: Number(f.operationhours) || 0,
    stockNumber: String(f.stocknumber || "").trim(),
    image: imageUrl(f),
    url: `/machines/${uniqueId}`,
  };
}

function buildCatalogMachines(items) {
  const byUid = new Map();

  for (const item of items) {
    const uniqueId = item.fieldData?.["unique-id"];
    if (uniqueId == null) continue;
    const key = String(uniqueId);
    if (!byUid.has(key)) byUid.set(key, []);
    byUid.get(key).push(item);
  }

  const machines = [];
  for (const group of byUid.values()) {
    const keeper = pickKeeper(group);
    if (!keeper || keeper.isArchived) continue;
    const machine = machineFromItem(keeper);
    if (machine) machines.push(machine);
  }

  machines.sort((a, b) => {
    const yearDiff = (b.year || 0) - (a.year || 0);
    if (yearDiff !== 0) return yearDiff;
    return String(a.make).localeCompare(String(b.make));
  });

  return machines;
}

function normalizeQueryParam(value) {
  if (value == null) return "";
  return String(value).trim();
}

function parseFilters(query) {
  return {
    category: normalizeQueryParam(query.category),
    make: normalizeQueryParam(query.make),
    model: normalizeQueryParam(query.model),
    location: normalizeQueryParam(query.location),
    yearMin: parseNumber(query.yearMin),
    yearMax: parseNumber(query.yearMax),
    priceMin: parseNumber(query.priceMin),
    priceMax: parseNumber(query.priceMax),
    q: normalizeQueryParam(query.q || query.search),
  };
}

function matchesSearch(machine, q) {
  if (!q) return true;
  const haystack = [
    machine.name,
    machine.make,
    machine.model,
    machine.category,
    machine.location,
    machine.stockNumber,
    String(machine.uniqueId),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q.toLowerCase());
}

function applyFilters(machines, filters, omit = {}) {
  return machines.filter((m) => {
    if (!omit.category && filters.category && m.category !== filters.category) {
      return false;
    }
    if (!omit.make && filters.make && m.make !== filters.make) return false;
    if (!omit.model && filters.model && m.model !== filters.model) return false;
    if (!omit.location && filters.location && m.location !== filters.location) {
      return false;
    }
    if (
      !omit.year &&
      filters.yearMin != null &&
      (m.year || 0) < filters.yearMin
    ) {
      return false;
    }
    if (
      !omit.year &&
      filters.yearMax != null &&
      (m.year || 0) > filters.yearMax
    ) {
      return false;
    }
    if (
      !omit.price &&
      filters.priceMin != null &&
      (m.price || 0) < filters.priceMin
    ) {
      return false;
    }
    if (
      !omit.price &&
      filters.priceMax != null &&
      (m.price || 0) > filters.priceMax
    ) {
      return false;
    }
    if (!omit.q && !matchesSearch(m, filters.q)) return false;
    return true;
  });
}

function buildFilterOptions(machines, filters) {
  return {
    categories: uniqueSorted(
      applyFilters(machines, filters, { category: true }).map((m) => m.category)
    ),
    makes: uniqueSorted(
      applyFilters(machines, filters, { make: true }).map((m) => m.make)
    ),
    models: uniqueSorted(
      applyFilters(machines, filters, { model: true }).map((m) => m.model)
    ),
    locations: uniqueSorted(
      applyFilters(machines, filters, { location: true }).map((m) => m.location)
    ),
  };
}

function buildBounds(machines) {
  const years = machines.map((m) => m.year).filter((y) => y > 0);
  const prices = machines.map((m) => m.price).filter((p) => p > 0);
  return {
    yearMin: years.length ? Math.min(...years) : null,
    yearMax: years.length ? Math.max(...years) : null,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
  };
}

function paginate(items, page, limit) {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const safePage = Math.max(1, page);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const clampedPage = Math.min(safePage, totalPages);
  const start = (clampedPage - 1) * safeLimit;
  return {
    items: items.slice(start, start + safeLimit),
    pagination: {
      page: clampedPage,
      limit: safeLimit,
      total,
      totalPages,
    },
  };
}

async function getCatalogMachines(getAllCollectionItems, { bypassCache = false } = {}) {
  const now = Date.now();
  if (
    !bypassCache &&
    catalogCache &&
    now - catalogCacheAt < CACHE_TTL_MS
  ) {
    return catalogCache;
  }

  const items = await getAllCollectionItems();
  catalogCache = buildCatalogMachines(items);
  catalogCacheAt = now;
  return catalogCache;
}

function queryUsedEquipment(allMachines, query) {
  const filters = parseFilters(query);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, parseInt(query.limit, 10) || 12);

  const filtered = applyFilters(allMachines, filters);
  const { items, pagination } = paginate(filtered, page, limit);

  return {
    items,
    pagination,
    filters,
    filterOptions: buildFilterOptions(allMachines, filters),
    bounds: buildBounds(allMachines),
    catalogTotal: allMachines.length,
  };
}

module.exports = {
  buildCatalogMachines,
  getCatalogMachines,
  queryUsedEquipment,
  parseFilters,
};
