const STACK_TRACE_MARKER = '--- Stack trace ---';

const DYNATRACE_SERVICE_ALIASES = {
  'freight-planning-admin-service': 'admin',
  'freight-planning-transaction-service': 'transaction',
  'freight-planning-invoice-service': 'invoice',
  admin: 'admin',
  transaction: 'transaction',
  invoice: 'invoice',
};

function resolveJiraServiceName(doc, override) {
  if (override) return String(override).trim().toLowerCase();

  const raw =
    doc?.serviceName || doc?.applicationName || doc?.service?.name || doc?.service_name || '';
  const key = String(raw).trim().toLowerCase();

  if (DYNATRACE_SERVICE_ALIASES[key]) return DYNATRACE_SERVICE_ALIASES[key];

  if (key.includes('admin')) return 'admin';
  if (key.includes('transaction')) return 'transaction';
  if (key.includes('invoice')) return 'invoice';

  return key || undefined;
}

function truncate(text, maxLen) {
  const value = String(text || '').trim();
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 1)}…`;
}

function buildDescriptionBody(doc) {
  const lines = [];

  if (doc.exceptionMessage) {
    lines.push(String(doc.exceptionMessage).trim());
  }

  const meta = [
    doc.incidentKey ? `Incident key: ${doc.incidentKey}` : null,
    doc.traceId ? `Trace ID: ${doc.traceId}` : null,
    doc.hostName ? `Host: ${doc.hostName}` : null,
    doc.occurredAt ? `Occurred: ${doc.occurredAt}` : null,
    doc.context?.source ? `Source: ${doc.context.source}` : null,
  ].filter(Boolean);

  if (meta.length) {
    if (lines.length) lines.push('');
    lines.push(...meta);
  }

  return lines.join('\n').trim();
}

function buildJiraDescription(doc) {
  const body = buildDescriptionBody(doc);
  const stackTrace = String(doc.stackTrace || '').trim();

  if (!stackTrace || stackTrace === String(doc.exceptionMessage || '').trim()) {
    return body;
  }

  if (!body) {
    return `${STACK_TRACE_MARKER}\n${stackTrace}`;
  }

  return `${body}\n\n${STACK_TRACE_MARKER}\n${stackTrace}`;
}

function buildJiraTitle(doc) {
  const type = doc.exceptionType || 'UnhandledException';
  const message = doc.exceptionMessage || doc.stackTrace?.split('\n')[0] || 'Dynatrace incident';
  return truncate(`[${type}] ${message}`, 250);
}

function buildJiraLabels(doc) {
  const labels = ['dynatrace-auto'];
  if (doc.incidentKey) {
    labels.push(
      `ik-${String(doc.incidentKey)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)}`
    );
  }
  return labels;
}

/**
 * Maps a Mongo incident document (Dynatrace poller / webhook shape) to Jira create + agent fields.
 */
function mapIncidentToJiraFields(doc, options = {}) {
  const serviceName = resolveJiraServiceName(doc, options.jiraServiceName);
  const description = buildJiraDescription(doc);
  const stackTrace = String(doc.stackTrace || '').trim() || undefined;

  let descriptionPlain = description;
  const markerIndex = description.indexOf(STACK_TRACE_MARKER);
  if (markerIndex !== -1) {
    descriptionPlain = description.slice(0, markerIndex).trim();
  }

  return {
    title: buildJiraTitle(doc),
    description,
    descriptionPlain,
    stackTrace,
    serviceName,
    severity: options.severity || 'Medium',
    labels: buildJiraLabels(doc),
  };
}

module.exports = {
  mapIncidentToJiraFields,
  resolveJiraServiceName,
  STACK_TRACE_MARKER,
};
