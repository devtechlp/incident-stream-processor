const { getDB } = require('../config/db');
const logger = require('../utils/logger');
const { resolveServiceName } = require('./serviceName');

const ROUTING_DOC_ID = 'routing';
const VALID_DESTINATIONS = new Set(['mongo', 'jira']);

function routingCollectionName() {
  return process.env.REMEDIATION_ROUTING_COLLECTION || 'remediation_routing';
}

function normalizeDestination(value) {
  const destination = String(value || 'mongo').trim().toLowerCase();
  if (!VALID_DESTINATIONS.has(destination)) {
    logger.warn(`Unknown destination "${value}" — defaulting to mongo`);
    return 'mongo';
  }
  return destination;
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

async function loadRoutingDoc() {
  const db = await getDB();
  return db.collection(routingCollectionName()).findOne({ _id: ROUTING_DOC_ID });
}

function findRuleForService(routing, serviceName) {
  return (routing?.rules || []).find((rule) => rule.serviceName === serviceName) || null;
}

/**
 * Resolves dispatch target for an incident: destination (mongo|jira), agent URL/key, and metadata.
 *
 * Fallback order for URL/key:
 *   1. Per-service rule in remediation_routing.rules[]
 *   2. Root defaultFunctionAppUrl / defaultFunctionAppKey on routing doc
 *   3. FUNCTION_APP_URL / FUNCTION_APP_KEY env vars
 */
async function resolveDispatchConfig(doc) {
  const serviceName = resolveServiceName(doc);

  let routing = null;
  try {
    routing = await loadRoutingDoc();
  } catch (err) {
    logger.error(`Failed to load routing config: ${err.message}`);
  }

  if (!routing) {
    logger.warn(
      `No routing doc in ${routingCollectionName()} — using FUNCTION_APP_URL env fallback`
    );
    const fallback = envFallback(serviceName);
    return {
      serviceName,
      destination: 'mongo',
      url: fallback.url,
      key: fallback.key,
      source: fallback.source,
      jiraServiceName: undefined,
    };
  }

  const rule = findRuleForService(routing, serviceName);
  const destination = normalizeDestination(rule?.destination ?? routing.defaultDestination);
  const source = rule ? `rule:${serviceName}` : 'default';

  if (destination === 'jira') {
    return {
      serviceName,
      destination: 'jira',
      url: null,
      key: null,
      source,
      jiraServiceName: rule?.jiraServiceName,
    };
  }

  const url = rule?.functionAppUrl ?? routing.defaultFunctionAppUrl;
  const key =
    rule?.functionAppKey ??
    routing.defaultFunctionAppKey ??
    process.env.FUNCTION_APP_KEY ??
    '';

  if (!url) {
    logger.warn(`Routing doc has no URL for ${serviceName} — using FUNCTION_APP_URL env fallback`);
    const fallback = envFallback(serviceName);
    return {
      serviceName,
      destination,
      url: fallback.url,
      key: fallback.key,
      source: fallback.source,
      jiraServiceName: rule?.jiraServiceName,
    };
  }

  return {
    serviceName,
    destination,
    url,
    key,
    source,
    jiraServiceName: rule?.jiraServiceName,
  };
}

/**
 * Resolves Function App URL/key for an incident. Reads MongoDB on every call (no cache).
 * @deprecated Prefer resolveDispatchConfig — kept for callers that only need URL/key.
 */
async function resolveAgentEndpoint(doc) {
  const config = await resolveDispatchConfig(doc);
  return { url: config.url, key: config.key, source: config.source };
}

module.exports = {
  resolveDispatchConfig,
  resolveAgentEndpoint,
  routingCollectionName,
  ROUTING_DOC_ID,
  resolveServiceName,
};
