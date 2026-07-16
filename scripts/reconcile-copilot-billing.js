#!/usr/bin/env node
/**
 * Manually re-fetch GitHub org ai_credit/usage for a Copilot incident and upgrade billing if reported.
 * Usage: node scripts/reconcile-copilot-billing.js <incidentMongoId|benchmarkRunId>
 */
require('dotenv').config();
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const { reconcileCopilotBilling } = require('../services/copilotBillingReconcile');

async function resolveIncidentId(arg) {
  if (/^[a-f\d]{24}$/i.test(arg)) {
    const db = await getDB();
    const col = db.collection(process.env.MONGO_COLLECTION || 'service_error_logs');
    const byId = await col.findOne({ _id: new ObjectId(arg) }, { projection: { _id: 1, benchmarkAgent: 1 } });
    if (byId) return String(byId._id);

    const copilot = await col.findOne(
      { benchmarkRunId: new ObjectId(arg), benchmarkAgent: 'copilot' },
      { projection: { _id: 1 } },
    );
    if (copilot) return String(copilot._id);
  }
  throw new Error(`Could not resolve Copilot incident from id: ${arg}`);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/reconcile-copilot-billing.js <incidentMongoId|benchmarkRunId>');
    process.exit(1);
  }

  const mongoId = await resolveIncidentId(arg);
  console.log(`Reconciling Copilot billing for incident ${mongoId} ...`);
  const result = await reconcileCopilotBilling(mongoId, { attempt: 1 });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.reported ? 0 : 2);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
