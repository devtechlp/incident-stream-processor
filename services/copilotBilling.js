const { ObjectId } = require('mongodb');

const { getDB } = require('../config/db');

const logger = require('../utils/logger');

const {
  fetchAiCreditUsageWithRetry,
  diffUsageSnapshots,
  hasBillableDelta,
  isAiCreditsBillingEnabled,
  alignBeforeSnapshotWithAfter,
} = require('./githubAiCredits');

const { logCopilotAiCreditUsage, logCopilotRemediationUsage } = require('./llmInvocationLogger');
const { scheduleBillingReconcile } = require('./copilotBillingReconcile');
const { resolveBillingDayAt } = require('./copilotBillingUtils');
const { resolveEffectiveBeforeSnapshot } = require('./copilotBillingChain');
const { maybeAdvanceCopilotModelQueue } = require('./copilotModelOrchestrator');

async function loadIncident(mongoId) {
  const col = (await getDB()).collection(process.env.MONGO_COLLECTION || 'service_error_logs');
  return col.findOne({ _id: new ObjectId(String(mongoId)) });
}

async function saveUsageSnapshot(mongoId, snapshot) {
  const col = (await getDB()).collection(process.env.MONGO_COLLECTION || 'service_error_logs');
  await col.updateOne(
    { _id: new ObjectId(String(mongoId)) },
    { $set: { copilotUsageSnapshot: snapshot } },
  );
}

async function setBillingStatus(mongoId, fields) {
  const col = (await getDB()).collection(process.env.MONGO_COLLECTION || 'service_error_logs');
  await col.updateOne(
    { _id: new ObjectId(String(mongoId)) },
    { $set: { copilotBillingLastCheckedAt: new Date(), ...fields } },
  );
}

/**
 * After Copilot PR: fetch GitHub billing usage, diff vs chained before snapshot, log llm_invocation.
 */
async function finalizeCopilotBilling(mongoId, { pr, repository, step = 'copilot_ai_credits_session' }) {
  const incident = await loadIncident(mongoId);

  if (!incident?.isBenchmark) {
    return { skipped: true, reason: 'not_benchmark' };
  }

  if (!isAiCreditsBillingEnabled()) {
    return logCopilotRemediationUsage(mongoId, pr, step === 'copilot_ai_credits_session' ? 'copilot_pr_opened' : step);
  }

  if (incident?.copilotBillingStatus === 'reported') {
    logger.info(`Copilot billing already reported for ${mongoId} — skipping duplicate PR webhook`);
    return { skipped: true, reason: 'already_reported' };
  }

  const owner = repository?.owner?.login;
  const repo = repository?.name;
  const repoFullName = incident?.githubRepo || (owner && repo ? `${owner}/${repo}` : null);

  const prMetadata = {
    prNumber: pr?.number,
    prUrl: pr?.html_url,
    changedFiles: pr?.changed_files,
    repository: repoFullName,
  };

  if (!incident?.copilotUsageSnapshot?.before) {
    logger.warn(`No copilotUsageSnapshot.before for ${mongoId} — falling back to estimated tokens`);
    await setBillingStatus(mongoId, {
      copilotBillingStatus: 'missing_before_snapshot',
      copilotBillingMode: 'estimated',
    });
    return logCopilotRemediationUsage(mongoId, pr, 'copilot_pr_opened');
  }

  try {
    const db = await getDB();
    const billingAt = resolveBillingDayAt(incident, pr);
    const { before, chainedBefore, preBenchmarkBefore, issueBefore, deltaBasis } = await resolveEffectiveBeforeSnapshot(incident, db);
    const after = await fetchAiCreditUsageWithRetry({ repository: repoFullName, at: billingAt });
    const alignedBefore = await alignBeforeSnapshotWithAfter(before, after, {
      repository: repoFullName,
      at: before?.capturedAt ? new Date(before.capturedAt) : billingAt,
    });
    const delta = diffUsageSnapshots(alignedBefore, after);

    await saveUsageSnapshot(mongoId, {
      before: alignedBefore,
      after,
      delta,
      chainedBefore: chainedBefore || null,
      preBenchmarkBefore: preBenchmarkBefore || null,
      issueBefore: issueBefore || null,
      deltaBasis,
      ...(alignedBefore !== before ? { realignedFromBefore: before } : {}),
    });

    if (!hasBillableDelta(delta)) {
      logger.warn(
        `Copilot billing delta is zero for ${mongoId} `
        + `(before items=${before.usageItemsCount ?? '?'}, after items=${after.usageItemsCount ?? '?'}, `
        + `source=${after.source}, deltaBasis=${deltaBasis}) — falling back to estimated tokens; scheduling billing reconcile`,
      );

      await setBillingStatus(mongoId, {
        copilotBillingStatus: 'api_pending',
        copilotBillingMode: 'estimated',
        copilotBillingNote:
          'GitHub ai_credit/usage returned no per-run delta yet. Using estimates until user/org billing API reports credits for the incident day.',
      });

      scheduleBillingReconcile(mongoId, { prMetadata });
      return logCopilotRemediationUsage(mongoId, pr, 'copilot_pr_opened');
    }

    await setBillingStatus(mongoId, {
      copilotBillingStatus: 'reported',
      copilotBillingMode: 'ai_credits',
      copilotBillingNote: null,
    });

    const result = await logCopilotAiCreditUsage(mongoId, {
      before: alignedBefore,
      after,
      delta,
      model: delta.models?.[0] || incident.copilotAssignment?.model,
      step,
      metadata: {
        ...prMetadata,
        billingSource: after.source,
        billingAccount: after.billingAccount,
        billingUser: after.user,
        quantityBasis: delta.quantityBasis,
        deltaBasis,
      },
    });

    await maybeAdvanceCopilotModelQueue(mongoId);
    return result;
  } catch (err) {
    logger.warn(`AI credits after-snapshot failed for ${mongoId}: ${err.message} — using estimate`);

    await setBillingStatus(mongoId, {
      copilotBillingStatus: 'api_error',
      copilotBillingMode: 'estimated',
      copilotBillingNote: err.message,
    });

    scheduleBillingReconcile(mongoId, { prMetadata });
    return logCopilotRemediationUsage(mongoId, pr, 'copilot_pr_opened');
  }
}

module.exports = {
  finalizeCopilotBilling,
  loadIncident,
  saveUsageSnapshot,
};
