const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');
const { loadBenchmarkConfig } = require('./benchmarkConfig');

function pickPayloadSnapshot(doc) {
  return {
    serviceName: doc.serviceName,
    applicationName: doc.applicationName,
    exceptionType: doc.exceptionType,
    exceptionMessage: doc.exceptionMessage,
    stackTrace: doc.stackTrace,
    traceId: doc.traceId,
    incidentKey: doc.incidentKey,
    context: doc.context,
  };
}

/**
 * Insert one Mongo incident per benchmark agent (same error payload, unique incidentKey/_id).
 * Change stream dispatches each to targetFunctionAppUrl on the child doc.
 */
async function createBenchmarkIncidents(baseDoc) {
  const config = await loadBenchmarkConfig(true);
  const agents = config?.agents || [];

  if (!config?.enabled) {
    return { skipped: true, reason: 'benchmark_disabled' };
  }
  if (agents.length === 0) {
    return { skipped: true, reason: 'no_agents_configured' };
  }

  const db = await getDB();
  const incidentCol = db.collection(process.env.MONGO_COLLECTION || 'service_error_logs');
  const runsCol = db.collection(process.env.BENCHMARK_RUNS_COLLECTION || 'benchmark_runs');

  const runId = new ObjectId();
  const baseKey = baseDoc.incidentKey || `${baseDoc.serviceName || 'unknown'}:benchmark`;
  const now = new Date();

  const childIncidents = {};
  const children = [];

  for (const agent of agents) {
    if (!agent?.functionAppUrl) {
      logger.warn(`Benchmark agent ${agent?.id || '?'} missing functionAppUrl — skipping`);
      continue;
    }

    const childId = new ObjectId();
    const child = {
      ...baseDoc,
      _id: childId,
      incidentKey: `${baseKey}:benchmark:${String(runId)}:${agent.id}`,
      benchmarkSourceKey: baseKey,
      isBenchmark: true,
      benchmarkRunId: runId,
      benchmarkAgent: agent.id,
      benchmarkAgentLabel: agent.label || agent.id,
      targetFunctionAppUrl: agent.functionAppUrl,
      targetFunctionAppKey: agent.functionAppKey || '',
      healingStatus: 'PENDING',
      createdAt: now,
      occurredAt: baseDoc.occurredAt || now,
      lastSeenAt: now,
      occurrenceCount: 1,
    };

    delete child.dispatchedAt;
    delete child.dispatchedTo;

    children.push(child);
    childIncidents[agent.id] = childId;
  }

  if (children.length === 0) {
    return { skipped: true, reason: 'no_valid_agents' };
  }

  await runsCol.insertOne({
    _id: runId,
    status: 'running',
    mode: config.mode || 'benchmark-only',
    sourceIncidentKey: baseKey,
    serviceName: baseDoc.serviceName,
    payloadSnapshot: pickPayloadSnapshot(baseDoc),
    childIncidents,
    agentIds: Object.keys(childIncidents),
    createdAt: now,
  });

  await incidentCol.insertMany(children);

  logger.info(
    `Benchmark run ${String(runId)}: inserted ${children.length} incident(s) for ${baseDoc.serviceName}`
  );

  return {
    skipped: false,
    benchmarkRunId: runId,
    count: children.length,
    childIncidents,
  };
}

module.exports = { createBenchmarkIncidents, pickPayloadSnapshot };
