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
  'github-copilot-playbook': { inputPer1kUsd: 0.002, outputPer1kUsd: 0.008, provider: 'github-copilot' },
  'github-copilot-swe': { inputPer1kUsd: 0.002, outputPer1kUsd: 0.008, provider: 'github-copilot' },
  default: { inputPer1kUsd: 0.002, outputPer1kUsd: 0.008, provider: 'github-copilot' },
};

function estimateTokens(text) {
  const len = String(text || '').length;
  if (len === 0) return 0;
  return Math.max(1, Math.ceil(len / 4));
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
}) {
  if (!incidentId) return null;

  try {
    const db = await getDB();
    const at = invokedAt ? new Date(invokedAt) : new Date();
    const rate = await resolveRateForModel(db, model, at, STATIC_FALLBACK);
    const total = totalTokens ?? promptTokens + completionTokens;
    const cost = calcCostFromRate(rate, promptTokens, completionTokens);
    const mongoId = new ObjectId(String(incidentId));

    await db.collection('llm_invocations').insertOne({
      incidentId: mongoId,
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
  const model = process.env.COPILOT_MODEL || 'github-copilot-swe';
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
    },
  });
}

module.exports = {
  logLlmInvocation,
  logCopilotRemediationUsage,
  estimateTokens,
  estimateCopilotPrTokens,
};
