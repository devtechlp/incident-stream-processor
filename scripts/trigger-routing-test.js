/**
 * Insert a one-off PENDING invoice incident to verify Copilot routing.
 * Change stream will forward it; delete the doc afterward if needed.
 *
 *   node scripts/trigger-routing-test.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDB } = require('../config/db');

const TEST_KEY = `freight-planning-invoice-service:routing-test:${Date.now()}`;

(async () => {
  const db = await getDB();
  const col = db.collection(process.env.MONGO_COLLECTION || 'service_error_logs');

  const doc = {
    incidentId: `routing-test-${Date.now()}`,
    traceId: null,
    spanId: null,
    serviceName: 'freight-planning-invoice-service',
    applicationName: 'freight-planning-invoice-service',
    hostName: 'routing-test',
    pid: 0,
    exceptionType: 'RoutingTestError',
    exceptionMessage: 'Synthetic incident to verify Copilot agent routing',
    stackTrace: 'RoutingTestError: synthetic test\n    at routing-test.js:1:1',
    causedByChain: ['RoutingTestError: synthetic test'],
    context: { source: 'routing-test-script' },
    createdAt: new Date(),
    occurredAt: new Date(),
    lastSeenAt: new Date(),
    occurrenceCount: 1,
    healingStatus: 'PENDING',
    incidentKey: TEST_KEY,
    _class: 'com.dynatrace.log.LogEntry',
  };

  const result = await col.insertOne(doc);
  console.log('Inserted test incident:', result.insertedId.toString());
  console.log('incidentKey:', TEST_KEY);
  console.log('Watch stream-processor logs for: via rule:freight-planning-invoice-service');
  process.exit(0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
