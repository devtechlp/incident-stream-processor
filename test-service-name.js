const { resolveServiceName } = require('./publisher/serviceName');

const cases = [
  [{ serviceName: 'freight-planning-admin-service' }, 'freight-planning-admin-service'],
  [{ applicationName: 'freight-planning-admin-service' }, 'freight-planning-admin-service'],
  [{ service: { name: 'freight-planning-invoice-service' } }, 'freight-planning-invoice-service'],
  [{}, 'unknown'],
];

for (const [doc, expected] of cases) {
  const actual = resolveServiceName(doc);
  if (actual !== expected) {
    console.error(`FAIL: expected ${expected}, got ${actual} for ${JSON.stringify(doc)}`);
    process.exit(1);
  }
}

console.log('OK — resolveServiceName');
