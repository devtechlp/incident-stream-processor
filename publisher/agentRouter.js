const { getDB } = require('../config/db');
const logger = require('../utils/logger');
const { resolveServiceName } = require('./serviceName');

const ROUTING_DOC_ID = 'routing';

function routingCollectionName() {
  return process.env.REMEDIATION_ROUTING_COLLECTION || 'remediation_routing';
}

function envFallback(serviceName) {
  const url = process.env.FUNCTION_APP_URL;
  const key = process.env.FUNCTION_APP_KEY || '';

  if (!url) {
    throw new Error(
      `No routing config in MongoDB and FUNCTION_APP_URL is not set (service: ${serviceName ?? 'unknown'})`
    );
  }

  return { url, key, source: 'env-fallback' };
}

/**
 * Resolves Function App URL/key for an incident. Reads MongoDB on every call (no cache).
 *
 * Fallback order:
 *   1. Per-service rule in remediation_routing.rules[]
 *   2. Root defaultFunctionAppUrl / defaultFunctionAppKey on routing doc
 *   3. FUNCTION_APP_URL / FUNCTION_APP_KEY env vars
 */
async function resolveAgentEndpoint(doc) {
  const serviceName = resolveServiceName(doc);

  try {
    const db = await getDB();
    const routing = await db
      .collection(routingCollectionName())
      .findOne({ _id: ROUTING_DOC_ID });

    if (!routing) {
      logger.warn(
        `No routing doc in ${routingCollectionName()} — using FUNCTION_APP_URL env fallback`
      );
      return envFallback(serviceName);
    }

    const rule = (routing.rules || []).find((r) => r.serviceName === serviceName);

    const url = rule?.functionAppUrl ?? routing.defaultFunctionAppUrl;
    const key =
      rule?.functionAppKey ??
      routing.defaultFunctionAppKey ??
      process.env.FUNCTION_APP_KEY ??
      '';

    if (!url) {
      logger.warn(
        `Routing doc has no URL for ${serviceName} — using FUNCTION_APP_URL env fallback`
      );
      return envFallback(serviceName);
    }

    const source = rule ? `rule:${serviceName}` : 'default';
    return { url, key, source };
  } catch (err) {
    logger.error(`Failed to load routing config: ${err.message} — using env fallback`);
    return envFallback(serviceName);
  }
}

module.exports = { resolveAgentEndpoint, routingCollectionName, ROUTING_DOC_ID, resolveServiceName };
