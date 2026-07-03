const logger = require('../utils/logger');
const { updateIncidentStatus, markCopilotPrFailed } = require('./incidentStatusUpdate');
const {
  fetchPullRequestStats,
  hasDeliverableChanges,
  resolveIncidentMongoId,
} = require('./copilotPrValidation');
const { logCopilotRemediationUsage } = require('./llmInvocationLogger');

const pendingTimers = new Map();

function recheckDelayMs() {
  const configured = Number(process.env.COPILOT_PR_RECHECK_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 300000;
}

function scheduleKey(owner, repo, pullNumber) {
  return `${owner}/${repo}#${pullNumber}`;
}

function cancelScheduledRecheck(owner, repo, pullNumber) {
  const key = scheduleKey(owner, repo, pullNumber);
  const timer = pendingTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(key);
  }
}

async function recheckCopilotPr({ mongoId, owner, repo, pullNumber, prUrl }) {
  if (!process.env.GITHUB_TOKEN) {
    logger.warn(`Copilot PR recheck skipped for #${pullNumber} — GITHUB_TOKEN not set`);
    return { ok: false, reason: 'GITHUB_TOKEN not set' };
  }

  try {
    const pr = await fetchPullRequestStats(owner, repo, pullNumber);
    const resolvedMongoId = mongoId || (await resolveIncidentMongoId(pr, { owner: { login: owner }, name: repo }));

    if (!resolvedMongoId) {
      logger.warn(`Copilot PR recheck for #${pullNumber} — Incident MongoDB ID not found`);
      return { ok: false, reason: 'Incident MongoDB ID not found' };
    }

    if (hasDeliverableChanges(pr)) {
      cancelScheduledRecheck(owner, repo, pullNumber);
      const result = await updateIncidentStatus(resolvedMongoId, {
        healingStatus: 'PR_RAISED',
        prUrl: pr.html_url || prUrl,
        prBranch: pr.head?.ref,
      });
      await logCopilotRemediationUsage(resolvedMongoId, pr, 'copilot_pr_recheck');
      logger.info(`Copilot PR recheck: PR #${pullNumber} now has changes -> PR_RAISED`);
      return { ok: true, outcome: 'PR_RAISED', result };
    }

    const result = await markCopilotPrFailed(resolvedMongoId, {
      prUrl: pr.html_url || prUrl,
      reason: 'Copilot PR had no file changes after recheck window',
    });
    logger.warn(`Copilot PR recheck: PR #${pullNumber} still empty -> FAILED`);
    return { ok: true, outcome: 'FAILED', result };
  } catch (err) {
    logger.error(`Copilot PR recheck failed for #${pullNumber}: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

function scheduleEmptyCopilotPrRecheck({ mongoId, pr, owner, repo }) {
  if (!pr?.number) return;

  const key = scheduleKey(owner, repo, pr.number);
  if (pendingTimers.has(key)) return;

  const delayMs = recheckDelayMs();
  const timer = setTimeout(() => {
    pendingTimers.delete(key);
    recheckCopilotPr({
      mongoId,
      owner,
      repo,
      pullNumber: pr.number,
      prUrl: pr.html_url,
    }).catch((err) => {
      logger.error(`Scheduled Copilot PR recheck error: ${err.message}`);
    });
  }, delayMs);

  pendingTimers.set(key, timer);
  logger.info(
    `Scheduled Copilot PR recheck in ${Math.round(delayMs / 1000)}s for ${owner}/${repo}#${pr.number}`
  );
}

module.exports = {
  scheduleEmptyCopilotPrRecheck,
  recheckCopilotPr,
  cancelScheduledRecheck,
  recheckDelayMs,
};
