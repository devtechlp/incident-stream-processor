const { getDB } = require('../config/db');
const logger = require('../utils/logger');

const CONFIG_DOC_ID = 'default';
const CACHE_TTL_MS = Number(process.env.BENCHMARK_CONFIG_CACHE_TTL_MS || 30000);

let cache = { loadedAt: 0, config: null };

function collectionName() {
  return process.env.BENCHMARK_CONFIG_COLLECTION || 'benchmark_config';
}

function serviceMatches(serviceName, services) {
  const list = services?.length ? services : ['*'];
  if (list.includes('*')) return true;
  return list.some((s) => s === serviceName);
}

async function loadBenchmarkConfig(force = false) {
  if (!force && cache.config && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.config;
  }

  try {
    const db = await getDB();
    const doc = await db.collection(collectionName()).findOne({ _id: CONFIG_DOC_ID });
    cache = { loadedAt: Date.now(), config: doc };
    return doc;
  } catch (err) {
    logger.error(`Failed to load benchmark config: ${err.message}`);
    return null;
  }
}

function invalidateBenchmarkConfigCache() {
  cache = { loadedAt: 0, config: null };
}

async function isBenchmarkEnabledForService(serviceName) {
  const config = await loadBenchmarkConfig();
  if (!config?.enabled) return false;
  return serviceMatches(serviceName, config.services);
}

module.exports = {
  loadBenchmarkConfig,
  invalidateBenchmarkConfigCache,
  isBenchmarkEnabledForService,
  serviceMatches,
  CONFIG_DOC_ID,
  collectionName,
};
