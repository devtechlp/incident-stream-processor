const express = require('express');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');

const router = express.Router();

// Extract the first matching entity name by entityType from ImpactedEntities array.
// Dynatrace sends e.g. [{ entityId: "HOST-xxx", name: "pod-name", entityType: "HOST" }, ...]
function extractEntityName(entities, type) {
  if (!Array.isArray(entities)) return null;
  const match = entities.find((e) => e.entityType === type);
  return match ? match.name : null;
}

// Extract service name embedded in log text e.g. "service=incident-java-exception-service"
function extractServiceFromLog(logText) {
  const match = logText.match(/service=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// Build a tags array regardless of whether Dynatrace sent a string or array.
function normalizeTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

function mapToIncidentDocument(payload) {
  const entities = payload.ImpactedEntities || [];
  const tags = normalizeTags(payload.Tags);
  const logText = payload.ProblemDetailsText || payload.ProblemDetails || '';

  const applicationName =
  extractServiceFromLog(logText) ||            // ← "incident-java-exception-service"
  extractEntityName(entities, 'SERVICE') ||
  extractEntityName(entities, 'APPLICATION') ||
  (Array.isArray(payload.ImpactedEntityNames)
    ? payload.ImpactedEntityNames[0]
    : payload.ImpactedEntityNames) ||
  'unknown';

  const hostName =
    extractEntityName(entities, 'HOST') ||
    extractEntityName(entities, 'PROCESS_GROUP_INSTANCE') ||
    'unknown';

  return {
    // Core fields matching the existing document schema
    errorId: Date.now(),                                     // unique Long — no sequential ID from Dynatrace
    traceId: payload.ProblemID,                              // Dynatrace problem ID used as trace identifier
    serviceName: applicationName,
    applicationName,
    hostName,
    pid: 0,                                                  // not available from Dynatrace
    exceptionType: `dynatrace.${payload.Severity || 'UNKNOWN'}.${payload.EventType || 'PROBLEM'}`,
    exceptionMessage: payload.ProblemTitle || '',
    stackTrace: payload.ProblemDetailsText || payload.ProblemDetails || '',
    causedByChain: payload.ProblemTitle ? [payload.ProblemTitle] : [],

    // Context carries Dynatrace-specific metadata that has no field in the base schema
    context: {
      source: 'dynatrace',
      problemId: payload.ProblemID,
      problemUrl: payload.ProblemURL || '',
      state: payload.State,
      severity: payload.Severity || '',
      impactLevel: payload.ImpactLevel || '',
      tags,
      impactedEntities: entities,
    },

    occurredAt: new Date(),
    healingStatus: 'PENDING',
    _class: 'com.dynatrace.problem.ProblemNotification',
  };
}

router.post('/webhook', async (req, res) => {
  // Validate token if configured (add as custom HTTP header in Dynatrace notification settings)
  const expectedToken = process.env.DYNATRACE_WEBHOOK_TOKEN;
  if (expectedToken) {
    const receivedToken = req.headers['x-dynatrace-token'];
    if (receivedToken !== expectedToken) {
      logger.warn('Dynatrace webhook: rejected — invalid or missing x-dynatrace-token');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const payload = req.body;

  if (!payload || !payload.ProblemID) {
    logger.warn('Dynatrace webhook: payload missing ProblemID — ignoring');
    return res.status(400).json({ error: 'Missing ProblemID in payload' });
  }

  // RESOLVED problems need no remediation — acknowledge and drop
  if (payload.State === 'RESOLVED') {
    logger.info(`Dynatrace webhook: skipping RESOLVED problem ${payload.ProblemID}`);
    return res.status(200).json({ status: 'skipped', reason: 'Problem already resolved' });
  }

  const doc = mapToIncidentDocument(payload);

  try {
    const db = await getDB();
    const collection = db.collection(process.env.MONGO_COLLECTION);
    const result = await collection.insertOne(doc);

    logger.info(`Dynatrace incident inserted: ${result.insertedId} — Problem: ${payload.ProblemID}`);
    return res.status(201).json({ status: 'accepted', incidentId: result.insertedId });
  } catch (err) {
    logger.error(`Dynatrace webhook: failed to insert incident — ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
