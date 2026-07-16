const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');
const {
  fetchOrgAiCreditUsageWithRetry,
  diffUsageSnapshots,
  hasBillableDelta,
  isAiCreditsBillingEnabled,
} = require('./githubAiCredits');
const { logCopilotAiCreditUsage } = require('./llmInvocationLogger');
const { resolveBillingDayAt } = require('./copilotBillingUtils');
const { resolveEffectiveBeforeSnapshot } = require('./copilotBillingChain');
const { maybeAdvanceCopilotModelQueue } = require('./copilotModelOrchestrator');

const pendingTimers = new Map();

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

function reconcileDelaysMs() {
  const raw = process.env.COPILOT_BILLING_RECONCILE_DELAYS_MS || '3600000,21600000,86400000';
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
}

function timerKey(mongoId, attempt) {
  return `${mongoId}:${attempt}`;
}

function cancelScheduledBillingReconcile(mongoId) {
  for (const [key, timer] of pendingTimers.entries()) {
    if (key.startsWith(`${mongoId}:`)) {
      clearTimeout(timer);
      pendingTimers.delete(key);
    }
  }
}

async function setBillingStatus(mongoId, fields) {
  const col = (await getDB()).collection(process.env.MONGO_COLLECTION || 'service_error_logs');
  await col.updateOne(
    { _id: new ObjectId(String(mongoId)) },
    { $set: { copilotBillingLastCheckedAt: new Date(), ...fields } },
  );
}

/**
 * Re-fetch org ai_credit/usage and upgrade estimated billing when GitHub eventually reports items.
 * The billing UI can show Copilot Cloud Agent credits before this REST endpoint populates usageItems.
 */
async function reconcileCopilotBilling(mongoId, { attempt = 1, prMetadata = {} } = {}) {
  if (!isAiCreditsBillingEnabled()) {
    return { ok: false, reason: 'ai_credits billing disabled' };
  }

  const incident = await loadIncident(mongoId);
  if (!incident) return { ok: false, reason: 'incident not found' };
  if (incident.copilotBillingStatus === 'reported') {
    return { ok: true, reason: 'already reported' };
  }
  if (!incident.copilotUsageSnapshot?.before) {
    await setBillingStatus(mongoId, {
      copilotBillingStatus: 'missing_before_snapshot',
    });
    return { ok: false, reason: 'missing before snapshot' };
  }

  const repoFullName = incident.githubRepo || null;
  const billingAt = resolveBillingDayAt(incident);
  const db = await getDB();
  const { before, chainedBefore, preBenchmarkBefore, issueBefore, deltaBasis } = await resolveEffectiveBeforeSnapshot(incident, db);

  try {
    const after = await fetchOrgAiCreditUsageWithRetry({ repository: repoFullName, at: billingAt });
    const delta = diffUsageSnapshots(before, after);

    await saveUsageSnapshot(mongoId, {
      ...incident.copilotUsageSnapshot,
      before,
      after,
      delta,
      chainedBefore: chainedBefore || null,
      preBenchmarkBefore: preBenchmarkBefore || null,
      issueBefore: issueBefore || null,
      deltaBasis,
      lastReconcileAttempt: attempt,
      lastReconcileAt: new Date().toISOString(),
    });

    if (hasBillableDelta(delta)) {
      cancelScheduledBillingReconcile(mongoId);
      await logCopilotAiCreditUsage(mongoId, {
        before,
        after,
        delta,
        model: delta.models?.[0] || incident.copilotAssignment?.model,
        step: 'copilot_ai_credits_session',
        metadata: {
          ...prMetadata,
          repository: repoFullName,
          billingSource: after.source,
          billingAccount: after.billingAccount,
          billingUser: after.user,
          quantityBasis: delta.quantityBasis,
          deltaBasis,
          reconciled: true,
          reconcileAttempt: attempt,
        },
      });
      await setBillingStatus(mongoId, {
        copilotBillingStatus: 'reported',
        copilotBillingMode: 'ai_credits',
        copilotBillingNote: before?.billingAccount === 'org' && (before?.aiCredits || 0) === 0
          ? 'Credits from personal Copilot Pro billing API (daily Cloud Agent total for the incident UTC day).'
          : null,
      });
      logger.info(`Copilot billing reconcile succeeded for ${mongoId} on attempt ${attempt} — ${delta.deltaCredits} credits`);
      await maybeAdvanceCopilotModelQueue(mongoId);
      return { ok: true, reported: true, delta };
    }

    await setBillingStatus(mongoId, {
      copilotBillingStatus: 'api_pending',
      copilotBillingNote:
        'GitHub org ai_credit/usage returned no billable delta yet. Billing UI may show Copilot Cloud Agent credits before this REST API populates usageItems.',
    });
    logger.warn(
      `Copilot billing reconcile attempt ${attempt} for ${mongoId} — API still empty `
      + `(before items=${before.usageItemsCount ?? 0}, after items=${after.usageItemsCount ?? 0})`,
    );
    return { ok: true, reported: false, afterItems: after.usageItemsCount ?? 0 };
  } catch (err) {
    await setBillingStatus(mongoId, {
      copilotBillingStatus: 'api_error',
      copilotBillingNote: err.message,
    });
    logger.warn(`Copilot billing reconcile failed for ${mongoId}: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

function scheduleBillingReconcile(mongoId, { attempt = 1, prMetadata = {} } = {}) {
  const delays = reconcileDelaysMs();
  const delayMs = delays[attempt - 1];
  if (!delayMs) return;

  const key = timerKey(mongoId, attempt);
  if (pendingTimers.has(key)) return;

  const timer = setTimeout(() => {
    pendingTimers.delete(key);
    reconcileCopilotBilling(mongoId, { attempt, prMetadata })
      .then((result) => {
        if (!result.reported && attempt < delays.length) {
          scheduleBillingReconcile(mongoId, { attempt: attempt + 1, prMetadata });
        }
      })
      .catch((err) => {
        logger.error(`Scheduled Copilot billing reconcile error: ${err.message}`);
      });
  }, delayMs);

  pendingTimers.set(key, timer);
  logger.info(
    `Scheduled Copilot billing reconcile #${attempt} in ${Math.round(delayMs / 1000)}s for incident ${mongoId}`,
  );
}

module.exports = {
  reconcileCopilotBilling,
  scheduleBillingReconcile,
  cancelScheduledBillingReconcile,
  reconcileDelaysMs,
};
