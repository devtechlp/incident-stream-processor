const { getDB } = require('../config/db');
const logger = require('../utils/logger');

const CONFIG_DOC_ID = 'default';
const CACHE_TTL_MS = Number(process.env.COPILOT_BENCHMARK_CONFIG_CACHE_TTL_MS || 30000);

let cache = { loadedAt: 0, config: null };

function collectionName() {
  return process.env.COPILOT_BENCHMARK_CONFIG_COLLECTION || 'copilot_benchmark_config';
}

async function loadCopilotBenchmarkConfig(force = false) {
  if (!force && cache.config && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.config;
  }

  try {
    const db = await getDB();
    const doc = await db.collection(collectionName()).findOne({ _id: CONFIG_DOC_ID });
    cache = { loadedAt: Date.now(), config: doc };
    return doc;
  } catch (err) {
    logger.error(`Failed to load copilot benchmark config: ${err.message}`);
    return null;
  }
}

function invalidateCopilotBenchmarkConfigCache() {
  cache = { loadedAt: 0, config: null };
}

function isCopilotModelBenchmarkEnabled(config) {
  return Boolean(config?.enabled && Array.isArray(config.models) && config.models.length > 0);
}

module.exports = {
  loadCopilotBenchmarkConfig,
  invalidateCopilotBenchmarkConfigCache,
  isCopilotModelBenchmarkEnabled,
  CONFIG_DOC_ID,
  collectionName,
};
