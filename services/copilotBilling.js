const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');
const {
  fetchOrgAiCreditUsage,
  fetchOrgAiCreditUsageWithRetry,
  diffUsageSnapshots,
  hasBillableDelta,
  isAiCreditsBillingEnabled,
} = require('./githubAiCredits');
const { logCopilotAiCreditUsage, logCopilotRemediationUsage } = require('./llmInvocationLogger');

async function loadIncident(mongoId) {
  const col = (await getDB()).collection(process.env.MONGO_COLLECTION || 'service_error_logs');
  return col.findOne({ _id: new ObjectId(String(mongoId)) });
}

async function saveUsageSnapshot(mongoId, snapshot) {
  const col = (await getDB()).collection(process.env.MONGO_COLLECTION || 'service_error_logs');
  await col.updateOne(
    { _id: new ObjectId(String(mongoId)) },
    { $set: { copilotUsageSnapshot: snapshot } }
  );
}

/**
 * After Copilot PR: fetch GitHub billing usage, diff vs before-assign snapshot, log llm_invocation.
 */
async function finalizeCopilotBilling(mongoId, { pr, repository, step = 'copilot_ai_credits_session' }) {
  if (!isAiCreditsBillingEnabled()) {
    return logCopilotRemediationUsage(mongoId, pr, step === 'copilot_ai_credits_session' ? 'copilot_pr_opened' : step);
  }

  const incident = await loadIncident(mongoId);
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  const repoFullName = incident?.githubRepo || (owner && repo ? `${owner}/${repo}` : null);

  if (!incident?.copilotUsageSnapshot?.before) {
    logger.warn(`No copilotUsageSnapshot.before for ${mongoId} — falling back to estimated tokens`);
    return logCopilotRemediationUsage(mongoId, pr, 'copilot_pr_opened');
  }

  try {
    const after = await fetchOrgAiCreditUsageWithRetry({ repository: repoFullName });
    const before = incident.copilotUsageSnapshot.before;
    const delta = diffUsageSnapshots(before, after);

    await saveUsageSnapshot(mongoId, { before, after, delta });

    if (!hasBillableDelta(delta)) {
      logger.warn(
        `Copilot billing delta is zero for ${mongoId} `
        + `(before items=${before.usageItemsCount ?? '?'}, after items=${after.usageItemsCount ?? '?'}, `
        + `source=${after.source}) — falling back to estimated tokens`
      );
      return logCopilotRemediationUsage(mongoId, pr, 'copilot_pr_opened');
    }

    return logCopilotAiCreditUsage(mongoId, {
      before,
      after,
      delta,
      model: delta.models?.[0] || incident.copilotAssignment?.model,
      step,
      metadata: {
        prNumber: pr?.number,
        prUrl: pr?.html_url,
        changedFiles: pr?.changed_files,
        repository: repoFullName,
        billingSource: after.source,
        quantityBasis: delta.quantityBasis,
      },
    });
  } catch (err) {
    logger.warn(`AI credits after-snapshot failed for ${mongoId}: ${err.message} — using estimate`);
    return logCopilotRemediationUsage(mongoId, pr, 'copilot_pr_opened');
  }
}

module.exports = {
  finalizeCopilotBilling,
};
