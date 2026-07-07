const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');
const {
  resolveRateForModel,
  calcCostFromRate,
  pricingSnapshot,
} = require('./pricingRates');

const AGENT_NAME = 'incident-remediation-agent-copilot';

const STATIC_FALLBACK = {
  'claude-sonnet-5': {
    inputPer1MUsd: 2.5,
    cachedInputPer1MUsd: 0.25,
    outputPer1MUsd: 15.0,
    currency: 'USD',
    provider: 'github-copilot',
  },
  default: {
    inputPer1MUsd: 2.5,
    cachedInputPer1MUsd: 0.25,
    outputPer1MUsd: 15.0,
    currency: 'USD',
    provider: 'github-copilot',
  },
};

function estimateTokens(text) {
  const len = String(text || '').length;
  if (len === 0) return 0;
  return Math.max(1, Math.ceil(len / 4));
}

async function resolveBenchmarkFields(db, mongoId, overrides = {}) {
  if (overrides.benchmarkRunId) {
    return {
      benchmarkRunId: overrides.benchmarkRunId,
      benchmarkAgent: overrides.benchmarkAgent || null,
      isBenchmark: overrides.isBenchmark !== false,
    };
  }

  const doc = await db.collection(process.env.MONGO_COLLECTION || 'service_error_logs').findOne(
    { _id: mongoId },
    { projection: { benchmarkRunId: 1, benchmarkAgent: 1, isBenchmark: 1 } }
  );

  if (!doc?.benchmarkRunId) return {};

  return {
    benchmarkRunId: doc.benchmarkRunId,
    benchmarkAgent: doc.benchmarkAgent || null,
    isBenchmark: doc.isBenchmark === true,
  };
}

function estimateCopilotPrTokens(pr = {}) {
  const promptTokens =
    estimateTokens(pr.title)
    + estimateTokens(pr.body)
    + Math.max(0, Number(pr.changed_files || 0) * 50);

  const completionTokens = Math.max(
    0,
    Math.ceil(Number(pr.additions || 0) * 1.5) + Math.ceil(Number(pr.deletions || 0) * 0.5)
  );

  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

async function logLlmInvocation({
  incidentId,
  model,
  provider = 'github-copilot',
  step,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens,
  durationMs,
  status = 'success',
  metadata = {},
  invokedAt,
  benchmarkRunId,
  benchmarkAgent,
  isBenchmark,
}) {
  if (!incidentId) return null;

  try {
    const db = await getDB();
    const at = invokedAt ? new Date(invokedAt) : new Date();
    const rate = await resolveRateForModel(db, model, at, STATIC_FALLBACK);
    const total = totalTokens ?? promptTokens + completionTokens;
    const cost = calcCostFromRate(rate, promptTokens, completionTokens);
    const mongoId = new ObjectId(String(incidentId));
    const benchmarkFields = await resolveBenchmarkFields(db, mongoId, {
      benchmarkRunId,
      benchmarkAgent,
      isBenchmark,
    });

    await db.collection('llm_invocations').insertOne({
      incidentId: mongoId,
      ...benchmarkFields,
      agent: AGENT_NAME,
      model,
      provider,
      invokedAt: at,
      durationMs,
      request: { promptTokens },
      response: { completionTokens, totalTokens: total },
      cost,
      pricingSnapshot: pricingSnapshot(rate),
      step: step || 'unknown',
      status,
      metadata,
    });

    await db.collection(process.env.MONGO_COLLECTION || 'service_error_logs').updateOne(
      { _id: mongoId },
      {
        $inc: {
          'remediationCost.totalInputTokens': promptTokens,
          'remediationCost.totalOutputTokens': completionTokens,
          'remediationCost.totalCostUsd': cost.totalCostUsd,
          'remediationCost.invocationCount': 1,
        },
      }
    );

    return { promptTokens, completionTokens, totalTokens: total, cost, pricingSnapshot: pricingSnapshot(rate) };
  } catch (err) {
    logger.warn(`Failed to log LLM invocation: ${err.message}`);
    return null;
  }
}

async function logCopilotRemediationUsage(incidentId, pr, step = 'copilot_pr_opened') {
  const model = process.env.COPILOT_MODEL || 'claude-sonnet-5';
  const usage = estimateCopilotPrTokens(pr);
  return logLlmInvocation({
    incidentId,
    model,
    provider: 'github-copilot',
    step,
    ...usage,
    metadata: {
      prNumber: pr?.number,
      prUrl: pr?.html_url,
      changedFiles: pr?.changed_files,
      additions: pr?.additions,
      deletions: pr?.deletions,
      billingMode: 'estimated',
    },
  });
}

const AI_CREDITS_MODEL = 'github-copilot-ai-credits';

async function logCopilotAiCreditUsage(incidentId, {
  before,
  after,
  delta,
  model,
  step = 'copilot_ai_credits_session',
  metadata = {},
}) {
  if (!incidentId || !delta) return null;

  const resolvedModel = model || delta.models?.[0] || process.env.COPILOT_MODEL || AI_CREDITS_MODEL;
  const promptTokens = delta.deltaInputTokens || 0;
  const completionTokens = delta.deltaOutputTokens || 0;
  const cachedTokens = delta.deltaCachedTokens || 0;
  const totalTokens = promptTokens + completionTokens;
  const cost = {
    inputCostUsd: 0,
    outputCostUsd: 0,
    cachedInputCostUsd: 0,
    totalCostUsd: delta.deltaCostUsd,
  };

  try {
    const db = await getDB();
    const at = new Date();
    const mongoId = new ObjectId(String(incidentId));
    const benchmarkFields = await resolveBenchmarkFields(db, mongoId, {});

    const pricingSnap = {
      model: AI_CREDITS_MODEL,
      provider: 'github-copilot',
      currency: 'USD',
      creditUsdRate: delta.creditUsdRate ?? 0.01,
      deltaCredits: delta.deltaCredits,
      beforeCredits: before?.aiCredits ?? null,
      afterCredits: after?.aiCredits ?? null,
      underlyingModel: resolvedModel,
      effectiveFrom: at,
      sourceLabel: 'GitHub billing API — AI credits delta',
    };

    await db.collection('llm_invocations').insertOne({
      incidentId: mongoId,
      ...benchmarkFields,
      agent: AGENT_NAME,
      model: AI_CREDITS_MODEL,
      provider: 'github-copilot',
      invokedAt: at,
      request: { promptTokens, cachedTokens },
      response: { completionTokens, totalTokens },
      cost,
      pricingSnapshot: pricingSnap,
      step,
      status: 'success',
      metadata: {
        ...metadata,
        billingMode: 'ai_credits',
        deltaCredits: delta.deltaCredits,
        underlyingModel: resolvedModel,
      },
    });

    await db.collection(process.env.MONGO_COLLECTION || 'service_error_logs').updateOne(
      { _id: mongoId },
      {
        $inc: {
          'remediationCost.totalInputTokens': promptTokens,
          'remediationCost.totalOutputTokens': completionTokens,
          'remediationCost.totalCostUsd': cost.totalCostUsd,
          'remediationCost.invocationCount': 1,
        },
      }
    );

    return { promptTokens, completionTokens, totalTokens, cost, pricingSnapshot: pricingSnap };
  } catch (err) {
    logger.warn(`Failed to log Copilot AI credit usage: ${err.message}`);
    return null;
  }
}

module.exports = {
  logLlmInvocation,
  logCopilotRemediationUsage,
  logCopilotAiCreditUsage,
  estimateTokens,
  estimateCopilotPrTokens,
};
