/**
 * Versioned LLM pricing — canonical module (keep agent copies in sync).
 *
 * Lookup: latest row where model matches and effectiveFrom <= invocation time.
 * Cache refreshes every PRICING_CACHE_TTL_MS so Mongo updates apply without redeploy.
 */

const PRICING_CACHE_TTL_MS = Number(process.env.PRICING_CACHE_TTL_MS || 60000);

let cache = { loadedAt: 0, rows: [] };

function invalidatePricingCache() {
  cache = { loadedAt: 0, rows: [] };
}

async function loadPricingRows(db, collectionName = 'pricing_rates') {
  if (cache.rows.length && Date.now() - cache.loadedAt < PRICING_CACHE_TTL_MS) {
    return cache.rows;
  }
  cache.rows = await db
    .collection(collectionName)
    .find({})
    .sort({ model: 1, effectiveFrom: -1 })
    .toArray();
  cache.loadedAt = Date.now();
  return cache.rows;
}

function resolveRate(rows, model, asOf = new Date()) {
  const asOfTime = asOf instanceof Date ? asOf.getTime() : new Date(asOf).getTime();
  if (Number.isNaN(asOfTime)) return null;

  const match = rows
    .filter((row) => {
      if (row.model !== model) return false;
      const from = new Date(row.effectiveFrom).getTime();
      if (from > asOfTime) return false;
      if (row.effectiveTo && new Date(row.effectiveTo).getTime() <= asOfTime) return false;
      return true;
    })
    .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))[0];

  return match || null;
}

function calcCostFromRate(rate, promptTokens = 0, completionTokens = 0) {
  const inputPer1k = rate?.inputPer1kUsd ?? 0;
  const outputPer1k = rate?.outputPer1kUsd ?? 0;
  const inputCostUsd = (promptTokens / 1000) * inputPer1k;
  const outputCostUsd = (completionTokens / 1000) * outputPer1k;
  return {
    inputCostUsd: Number(inputCostUsd.toFixed(6)),
    outputCostUsd: Number(outputCostUsd.toFixed(6)),
    totalCostUsd: Number((inputCostUsd + outputCostUsd).toFixed(6)),
  };
}

function pricingSnapshot(rate) {
  if (!rate) return null;
  return {
    pricingRateId: rate._id ? String(rate._id) : undefined,
    model: rate.model,
    provider: rate.provider || null,
    inputPer1kUsd: rate.inputPer1kUsd,
    outputPer1kUsd: rate.outputPer1kUsd,
    effectiveFrom: rate.effectiveFrom,
    sourceUrl: rate.sourceUrl || null,
    sourceLabel: rate.sourceLabel || null,
  };
}

function staticFallbackRate(model, fallbackMap, asOf = new Date()) {
  const entry = fallbackMap[model] || fallbackMap.default;
  if (!entry) return null;
  return {
    model: fallbackMap[model] ? model : 'default',
    inputPer1kUsd: entry.inputPer1kUsd,
    outputPer1kUsd: entry.outputPer1kUsd,
    provider: entry.provider || null,
    effectiveFrom: asOf,
    sourceLabel: 'static-fallback (no pricing_rates row for invocation date)',
  };
}

async function resolveRateForModel(db, model, invokedAt = new Date(), fallbackMap = {}) {
  const rows = await loadPricingRows(db);
  const rate = resolveRate(rows, model, invokedAt);
  if (rate) return rate;
  return staticFallbackRate(model, fallbackMap, invokedAt);
}

module.exports = {
  loadPricingRows,
  resolveRate,
  resolveRateForModel,
  calcCostFromRate,
  pricingSnapshot,
  invalidatePricingCache,
  PRICING_CACHE_TTL_MS,
};
