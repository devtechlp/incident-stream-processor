const logger = require('../utils/logger');
const { isBenchmarkEnabledForService, loadBenchmarkConfig } = require('./benchmarkConfig');
const { createBenchmarkIncidents } = require('./benchmarkFanOut');

/**
 * Normal production upsert by incidentKey (one doc per unique error).
 */
async function upsertProductionIncident(col, doc, recordTimestamp) {
  const { lastSeenAt, occurrenceCount, ...insertDoc } = doc;

  const result = await col.updateOne(
    { incidentKey: doc.incidentKey },
    {
      $setOnInsert: insertDoc,
      $set: { lastSeenAt: new Date(recordTimestamp) },
      $inc: { occurrenceCount: 1 },
    },
    { upsert: true }
  );

  if (result.upsertedCount > 0) {
    logger.info(`NEW incident — ${doc.incidentKey}`);
    return { type: 'inserted', incidentKey: doc.incidentKey };
  }

  logger.info(`DUPLICATE — ${doc.incidentKey} (count incremented)`);
  return { type: 'duplicate', incidentKey: doc.incidentKey };
}

/**
 * When benchmark is enabled for this service:
 *   benchmark-only → fan-out once per unique incidentKey (no production upsert)
 *   both → production upsert + fan-out on first occurrence
 */
async function ingestIncidentDocument(col, doc, recordTimestamp) {
  const serviceName = doc.serviceName || doc.applicationName || 'unknown';
  const baseKey = doc.incidentKey;
  const benchmarkOn = await isBenchmarkEnabledForService(serviceName);
  const config = benchmarkOn ? await loadBenchmarkConfig() : null;
  const mode = config?.mode || 'benchmark-only';

  const outcomes = [];

  if (benchmarkOn && mode !== 'production-only') {
    const existingBench = await col.findOne({ benchmarkSourceKey: baseKey });
    if (existingBench) {
      logger.info(`Benchmark duplicate skipped — ${baseKey}`);
      outcomes.push({ type: 'benchmark_duplicate_skipped', incidentKey: baseKey });
    } else {
      const bench = await createBenchmarkIncidents(doc);
      if (!bench.skipped) {
        outcomes.push({ type: 'benchmark', ...bench });
      }
    }
  }

  if (!benchmarkOn || mode === 'both') {
    outcomes.push(await upsertProductionIncident(col, doc, recordTimestamp));
  }

  return outcomes;
}

module.exports = {
  upsertProductionIncident,
  ingestIncidentDocument,
};
