/**
 * Versioned LLM pricing — canonical module (keep agent copies in sync).
 * See mongodb/lib/pricingRates.js
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

function normalizeRateFields(rate) {
  if (!rate) {
    return { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0, currency: 'USD' };
  }

  if (rate.inputPer1MUsd != null) {
    return {
      inputPerM: Number(rate.inputPer1MUsd) || 0,
      cachedInputPerM: Number(rate.cachedInputPer1MUsd ?? rate.inputPer1MUsd) || 0,
      outputPerM: Number(rate.outputPer1MUsd) || 0,
      currency: rate.currency || 'USD',
    };
  }

  if (rate.inputPer1kUsd != null) {
    return {
      inputPerM: (Number(rate.inputPer1kUsd) || 0) * 1000,
      cachedInputPerM: (Number(rate.cachedInputPer1kUsd ?? rate.inputPer1kUsd) || 0) * 1000,
      outputPerM: (Number(rate.outputPer1kUsd) || 0) * 1000,
      currency: rate.currency || 'USD',
    };
  }

  return { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0, currency: rate.currency || 'USD' };
}

function calcCostFromRate(rate, promptTokens = 0, completionTokens = 0, cachedTokens = 0) {
  const { inputPerM, cachedInputPerM, outputPerM } = normalizeRateFields(rate);
  const cached = Math.min(Math.max(0, Number(cachedTokens) || 0), Math.max(0, promptTokens));
  const uncachedInput = Math.max(0, promptTokens - cached);

  const uncachedInputCostUsd = (uncachedInput / 1_000_000) * inputPerM;
  const cachedInputCostUsd = (cached / 1_000_000) * cachedInputPerM;
  const inputCostUsd = uncachedInputCostUsd + cachedInputCostUsd;
  const outputCostUsd = (completionTokens / 1_000_000) * outputPerM;

  return {
    inputCostUsd: Number(inputCostUsd.toFixed(6)),
    cachedInputCostUsd: Number(cachedInputCostUsd.toFixed(6)),
    outputCostUsd: Number(outputCostUsd.toFixed(6)),
    totalCostUsd: Number((inputCostUsd + outputCostUsd).toFixed(6)),
  };
}

function pricingSnapshot(rate) {
  if (!rate) return null;

  const snap = {
    pricingRateId: rate._id ? String(rate._id) : undefined,
    model: rate.model,
    provider: rate.provider || null,
    currency: rate.currency || 'USD',
    effectiveFrom: rate.effectiveFrom,
    sourceUrl: rate.sourceUrl || null,
    sourceLabel: rate.sourceLabel || null,
  };

  if (rate.inputPer1MUsd != null) {
    snap.inputPer1MUsd = rate.inputPer1MUsd;
    snap.cachedInputPer1MUsd = rate.cachedInputPer1MUsd ?? null;
    snap.outputPer1MUsd = rate.outputPer1MUsd;
  } else {
    snap.inputPer1kUsd = rate.inputPer1kUsd;
    snap.outputPer1kUsd = rate.outputPer1kUsd;
  }

  return snap;
}

function staticFallbackRate(model, fallbackMap, asOf = new Date()) {
  const entry = fallbackMap[model] || fallbackMap.default;
  if (!entry) return null;

  const resolvedModel = fallbackMap[model] ? model : 'default';

  if (entry.inputPer1MUsd != null) {
    return {
      model: resolvedModel,
      inputPer1MUsd: entry.inputPer1MUsd,
      cachedInputPer1MUsd: entry.cachedInputPer1MUsd ?? entry.inputPer1MUsd,
      outputPer1MUsd: entry.outputPer1MUsd,
      currency: entry.currency || 'USD',
      provider: entry.provider || null,
      effectiveFrom: asOf,
      sourceLabel: 'static-fallback (no pricing_rates row for invocation date)',
    };
  }

  return {
    model: resolvedModel,
    inputPer1kUsd: entry.inputPer1kUsd,
    outputPer1kUsd: entry.outputPer1kUsd,
    currency: entry.currency || 'USD',
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
  normalizeRateFields,
  calcCostFromRate,
  pricingSnapshot,
  invalidatePricingCache,
  PRICING_CACHE_TTL_MS,
};
