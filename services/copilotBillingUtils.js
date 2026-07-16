/**
 * Resolve which UTC calendar day to query in GitHub ai_credit/usage.
 * API returns daily cumulative totals — use the incident/issue day, not "now".
 */
function resolveBillingDayAt(incident, pr) {
  const raw = pr?.created_at
    || incident?.prCreatedAt
    || incident?.copilotUsageSnapshot?.before?.capturedAt
    || incident?.issueCreatedAt
    || incident?.agent_started_at;
  return raw ? new Date(raw) : new Date();
}

function resolveBeforeSnapshot(incident) {
  return incident?.copilotUsageSnapshot?.before || null;
}

module.exports = {
  resolveBillingDayAt,
  resolveBeforeSnapshot,
};
