const logger = require('../utils/logger');
const { fetchAiCreditUsage, isAiCreditsBillingEnabled } = require('./githubAiCredits');

/**
 * Live GitHub ai_credit/usage fetch at multi-model benchmark run start.
 * Stored on benchmark_runs.copilotBillingBaseline and used as sequence-0 before snapshot.
 */
async function captureCopilotBillingBaseline({ at = new Date() } = {}) {
  if (!isAiCreditsBillingEnabled()) {
    return null;
  }

  try {
    const snapshot = await fetchAiCreditUsage({ at });
    return {
      ...snapshot,
      capturedAtRunStart: true,
      baselineSource: 'github_ai_credit_usage',
    };
  } catch (err) {
    logger.warn(`Copilot billing baseline fetch failed at benchmark start: ${err.message}`);
    return null;
  }
}

function baselineCredits(baseline) {
  if (!baseline) return null;
  const credits = Number(baseline.aiCredits);
  return Number.isFinite(credits) && credits >= 0 ? credits : null;
}

module.exports = {
  captureCopilotBillingBaseline,
  baselineCredits,
};
