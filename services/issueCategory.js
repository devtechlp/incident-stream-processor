// Fixed-list issue categorization — regex/keyword only, no LLM calls.
// Kept in sync (duplicated, not shared) across incident-portal-api,
// incident-stream-processor, and incident-remediation-agent-jira,
// since those are independent repos with no shared package today.

const CATEGORY_LABEL_PREFIX = 'category:';

const EXCEPTION_CATEGORY_RULES = [
  [/(null\s*(pointer|reference)|attribute)/i, 'null-reference-error'],
  [/(validation|argument|bad\s*request|invalid|valueerror|typeerror|indexerror|outofbounds|notfound|noresourcefound)/i, 'validation-error'],
  [/(timeout|socket|connect|httpclient|refused|unreachable)/i, 'integration-timeout-error'],
  [/(sql|mongo|constraint|hibernate|jpa|database)/i, 'data-db-error'],
  [/(config|beancreation|missing.*env|wiring|startup|syntaxerror)/i, 'configuration-error'],
];

const UI_STYLE_KEYWORDS = /\b(colou?r|font|css|style|padding|margin|layout|theme|icon|spacing|align|border|background)\b/i;
const UI_MISSING_KEYWORDS = /\b(missing|not\s+(showing|visible|appearing)|doesn'?t\s+(show|appear)|absent)\b/i;
const TEXT_KEYWORDS = /\b(label|copy|wording|should\s+say|typo|placeholder)\b/i;
const BEHAVIOR_KEYWORDS = /\b(click|doesn'?t\s+work|not\s+working|workflow|does\s+not\s+work|interaction)\b/i;

function categorizeApplicationError(exceptionType) {
  if (!exceptionType) return 'uncategorized';
  for (const [regex, slug] of EXCEPTION_CATEGORY_RULES) {
    if (regex.test(exceptionType)) return slug;
  }
  return 'uncategorized';
}

function categorizeRequirementGap(text) {
  const value = String(text || '');
  if (UI_STYLE_KEYWORDS.test(value)) return 'visual-styling-mismatch';
  if (UI_MISSING_KEYWORDS.test(value)) return 'missing-ui-element';
  if (TEXT_KEYWORDS.test(value)) return 'text-copy-mismatch';
  if (BEHAVIOR_KEYWORDS.test(value)) return 'behavior-interaction-gap';
  return 'business-logic-gap';
}

/**
 * incidentType: 'application_error' | 'requirement_gap' | 'bulk_upload'
 * Returns a fixed-list category slug, or null for bulk_upload (categorization
 * doesn't apply at the parent-issue level for a batch container).
 */
function categorizeIncident({ incidentType, exceptionType, title = '', description = '' } = {}) {
  if (incidentType === 'requirement_gap') {
    return categorizeRequirementGap(`${title} ${description}`);
  }
  if (incidentType === 'bulk_upload') return null;
  return categorizeApplicationError(exceptionType);
}

module.exports = { categorizeIncident, CATEGORY_LABEL_PREFIX };
