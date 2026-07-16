const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');
const { loadBenchmarkConfig } = require('./benchmarkConfig');
const {
  loadCopilotBenchmarkConfig,
  isCopilotModelBenchmarkEnabled,
} = require('./copilotBenchmarkConfig');
const { QUEUED_STATUS } = require('./copilotModelOrchestrator');
const { captureCopilotBillingBaseline } = require('./copilotBillingBaseline');

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

function buildChildIncident(baseDoc, {
  runId,
  baseKey,
  now,
  agentKey,
  agentId,
  agentLabel,
  functionAppUrl,
  functionAppKey,
  healingStatus,
  copilotModel,
  copilotModelId,
  copilotModelLabel,
  copilotSequence,
}) {
  const childId = new ObjectId();
  const child = {
    ...baseDoc,
    _id: childId,
    incidentKey: `${baseKey}:benchmark:${String(runId)}:${agentKey}`,
    benchmarkSourceKey: baseKey,
    isBenchmark: true,
    benchmarkRunId: runId,
    benchmarkAgent: agentId,
    benchmarkAgentLabel: agentLabel,
    targetFunctionAppUrl: functionAppUrl,
    targetFunctionAppKey: functionAppKey || '',
    healingStatus,
    createdAt: now,
    occurredAt: baseDoc.occurredAt || now,
    lastSeenAt: now,
    occurrenceCount: 1,
  };

  if (copilotModelId) {
    child.benchmarkCopilotModelId = copilotModelId;
    child.benchmarkCopilotModel = copilotModel || copilotModelId;
    child.benchmarkCopilotModelLabel = copilotModelLabel || copilotModelId;
    child.benchmarkCopilotSequence = copilotSequence;
  }

  delete child.dispatchedAt;
  delete child.dispatchedTo;

  return { childId, child };
}

function appendCopilotModelChildren({
  baseDoc,
  runId,
  baseKey,
  now,
  copilotConfig,
  childIncidents,
  children,
}) {
  const models = copilotConfig.models || [];
  const modelIds = models.map((m) => m.id);

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    if (!model?.id) continue;

    const agentKey = `copilot:${model.id}`;
    const { childId, child } = buildChildIncident(baseDoc, {
      runId,
      baseKey,
      now,
      agentKey,
      agentId: 'copilot',
      agentLabel: model.label || `GitHub Copilot (${model.id})`,
      functionAppUrl: copilotConfig.functionAppUrl,
      functionAppKey: copilotConfig.functionAppKey,
      healingStatus: index === 0 ? 'PENDING' : QUEUED_STATUS,
      copilotModel: model.githubModel || model.id,
      copilotModelId: model.id,
      copilotModelLabel: model.label || model.id,
      copilotSequence: index,
    });

    children.push(child);
    childIncidents[agentKey] = childId;
  }

  return {
    enabled: true,
    execution: copilotConfig.execution || 'sequential',
    models: modelIds,
    currentModelIndex: 0,
    completedModels: [],
    status: 'running',
  };
}

/**
 * Insert one Mongo incident per benchmark agent (same error payload, unique incidentKey/_id).
 * Change stream dispatches each to targetFunctionAppUrl on the child doc.
 */
async function createBenchmarkIncidents(baseDoc) {
  const config = await loadBenchmarkConfig(true);
  const copilotConfig = await loadCopilotBenchmarkConfig(true);
  const agents = config?.agents || [];
  const multiModelCopilot = isCopilotModelBenchmarkEnabled(copilotConfig);

  if (!config?.enabled) {
    return { skipped: true, reason: 'benchmark_disabled' };
  }
  if (agents.length === 0 && !multiModelCopilot) {
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
  let copilotModelBenchmark = null;

  for (const agent of agents) {
    if (multiModelCopilot && agent?.id === 'copilot') {
      logger.info('Skipping single copilot agent — copilot_benchmark_config multi-model enabled');
      continue;
    }

    if (!agent?.functionAppUrl) {
      logger.warn(`Benchmark agent ${agent?.id || '?'} missing functionAppUrl — skipping`);
      continue;
    }

    const { childId, child } = buildChildIncident(baseDoc, {
      runId,
      baseKey,
      now,
      agentKey: agent.id,
      agentId: agent.id,
      agentLabel: agent.label || agent.id,
      functionAppUrl: agent.functionAppUrl,
      functionAppKey: agent.functionAppKey,
      healingStatus: 'PENDING',
    });

    children.push(child);
    childIncidents[agent.id] = childId;
  }

  if (multiModelCopilot) {
    if (!copilotConfig.functionAppUrl) {
      logger.warn('copilot_benchmark_config enabled but functionAppUrl missing — skipping Copilot models');
    } else {
      copilotModelBenchmark = appendCopilotModelChildren({
        baseDoc,
        runId,
        baseKey,
        now,
        copilotConfig,
        childIncidents,
        children,
      });
    }
  }

  if (children.length === 0) {
    return { skipped: true, reason: 'no_valid_agents' };
  }

  const runDoc = {
    _id: runId,
    status: 'running',
    mode: config.mode || 'benchmark-only',
    sourceIncidentKey: baseKey,
    serviceName: baseDoc.serviceName,
    payloadSnapshot: pickPayloadSnapshot(baseDoc),
    childIncidents,
    agentIds: Object.keys(childIncidents),
    createdAt: now,
  };

  if (copilotModelBenchmark) {
    runDoc.copilotModelBenchmark = copilotModelBenchmark;
    runDoc.copilotBillingBaseline = await captureCopilotBillingBaseline({ at: now });
    if (runDoc.copilotBillingBaseline?.aiCredits != null) {
      logger.info(
        `Benchmark run ${String(runId)}: GitHub billing baseline `
        + `${runDoc.copilotBillingBaseline.aiCredits} credits `
        + `(${runDoc.copilotBillingBaseline.source || 'ai_credit/usage'})`,
      );
    } else {
      logger.warn(`Benchmark run ${String(runId)}: no GitHub billing baseline captured at run start`);
    }
  }

  await runsCol.insertOne(runDoc);
  await incidentCol.insertMany(children);

  logger.info(
    `Benchmark run ${String(runId)}: inserted ${children.length} incident(s) for ${baseDoc.serviceName}`
    + (copilotModelBenchmark ? ` (${copilotModelBenchmark.models.length} Copilot models sequential)` : ''),
  );

  return {
    skipped: false,
    benchmarkRunId: runId,
    count: children.length,
    childIncidents,
    copilotModelBenchmark,
  };
}

module.exports = { createBenchmarkIncidents, pickPayloadSnapshot };
