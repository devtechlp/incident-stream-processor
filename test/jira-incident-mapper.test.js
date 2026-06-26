const assert = require('assert');
const {
  mapIncidentToJiraFields,
  resolveJiraServiceName,
  STACK_TRACE_MARKER,
} = require('../publisher/jiraIncidentMapper');

const sampleDoc = {
  serviceName: 'freight-planning-transaction-service',
  exceptionType: 'NullPointerException',
  exceptionMessage: 'Cannot invoke method on null reference',
  stackTrace: 'java.lang.NullPointerException\n\tat com.example.Service.run(Service.java:42)',
  incidentKey: 'freight-planning-transaction-service:NullPointerException:Service.java:42',
  traceId: 'abc123',
  hostName: 'pod-1',
  occurredAt: new Date('2026-06-25T10:00:00Z'),
  context: { source: 'dynatrace-log-poller' },
};

const mapped = mapIncidentToJiraFields(sampleDoc);

assert.equal(resolveJiraServiceName(sampleDoc), 'transaction');
assert.equal(mapped.serviceName, 'transaction');
assert.ok(mapped.title.includes('NullPointerException'));
assert.ok(mapped.description.includes('Cannot invoke method on null reference'));
assert.ok(mapped.description.includes(STACK_TRACE_MARKER));
assert.ok(mapped.description.includes('java.lang.NullPointerException'));
assert.ok(mapped.descriptionPlain.includes('Cannot invoke method on null reference'));
assert.ok(mapped.descriptionPlain.includes('Incident key:'));
assert.ok(mapped.labels.includes('dynatrace-auto'));

const override = mapIncidentToJiraFields(sampleDoc, { jiraServiceName: 'invoice' });
assert.equal(override.serviceName, 'invoice');

console.log('jira-incident-mapper tests passed');
