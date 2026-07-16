const { ObjectId } = require('mongodb');

const CREDIT_USD_RATE = Number(process.env.COPILOT_CREDIT_USD_RATE || 0.01);

function snapshotCredits(snapshot) {
  if (!snapshot) return 0;
  const credits = Number(snapshot.aiCredits);
  if (Number.isFinite(credits) && credits >= 0) return credits;
  const costUsd = Number(snapshot.costUsd);
  if (Number.isFinite(costUsd) && costUsd > 0) {
    return Number((costUsd / CREDIT_USD_RATE).toFixed(6));
  }
  return 0;
}

function pickBillingBaseline(...candidates) {
  return candidates.filter(Boolean).reduce((best, current) => {
    if (!best) return current;
    return snapshotCredits(current) > snapshotCredits(best) ? current : best;
  }, null);
}

async function loadBenchmarkRun(incident, db) {
  if (!incident?.benchmarkRunId) return null;
  const runsCol = db.collection(process.env.BENCHMARK_RUNS_COLLECTION || 'benchmark_runs');
  return runsCol.findOne(
    { _id: new ObjectId(String(incident.benchmarkRunId)) },
    { projection: { createdAt: 1, copilotModelBenchmark: 1, copilotBillingBaseline: 1 } },
  );
}

async function loadPreviousBenchmarkModelAfter(incident, db) {
  const sequence = incident?.benchmarkCopilotSequence;
  if (sequence == null || sequence <= 0 || !incident?.benchmarkRunId) return null;

  const col = db.collection(process.env.MONGO_COLLECTION || 'service_error_logs');
  const previous = await col.findOne(
    {
      benchmarkRunId: new ObjectId(String(incident.benchmarkRunId)),
      benchmarkCopilotSequence: sequence - 1,
    },
    { projection: { copilotUsageSnapshot: 1 } },
  );

  return previous?.copilotUsageSnapshot?.after || null;
}

/**
 * Live GitHub billing baseline captured when the multi-model benchmark run started.
 */
async function loadPreBenchmarkBillingBaseline(incident, db) {
  if (incident?.benchmarkCopilotSequence !== 0 || !incident?.benchmarkRunId) return null;

  const run = await loadBenchmarkRun(incident, db);
  if (!run?.copilotModelBenchmark?.enabled || !run?.copilotBillingBaseline) return null;

  return run.copilotBillingBaseline;
}

/**
 * Resolve the billing baseline for an incident.
 * Sequential benchmark models chain from the previous model's after snapshot.
 * The first model chains from the live GitHub baseline captured at run start.
 */
async function resolveEffectiveBeforeSnapshot(incident, db) {
  const issueBefore = incident?.copilotUsageSnapshot?.before || null;
  const chainedBefore = await loadPreviousBenchmarkModelAfter(incident, db);
  const preBenchmarkBefore = await loadPreBenchmarkBillingBaseline(incident, db);

  if (incident?.benchmarkCopilotSequence > 0 && chainedBefore) {
    return {
      before: pickBillingBaseline(chainedBefore, issueBefore) || chainedBefore,
      chainedBefore,
      preBenchmarkBefore,
      issueBefore,
      deltaBasis: 'chained',
    };
  }

  if (incident?.benchmarkCopilotSequence === 0 && preBenchmarkBefore) {
    return {
      before: pickBillingBaseline(preBenchmarkBefore, issueBefore) || preBenchmarkBefore,
      chainedBefore,
      preBenchmarkBefore,
      issueBefore,
      deltaBasis: 'github_run_start_baseline',
    };
  }

  return {
    before: issueBefore,
    chainedBefore,
    preBenchmarkBefore,
    issueBefore,
    deltaBasis: 'issue_before',
  };
}

function resolvePreBenchmarkBaselineValue(row, explicitBaseline = 0) {
  if (explicitBaseline > 0) return explicitBaseline;
  const fromSnapshot = snapshotCredits(row?.copilotUsageSnapshot?.preBenchmarkBefore);
  if (fromSnapshot > 0) return fromSnapshot;
  const direct = Number(row?.preBenchmarkBaselineCredits);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  return 0;
}

/**
 * Derive per-model incremental credits from cumulative after snapshots (dashboard/API).
 */
function deriveSequentialIncrementalCredits(rows = [], preBenchmarkBaseline = 0) {
  const eligible = rows
    .filter((row) => row?.benchmarkCopilotSequence != null && row.copilotUsageSnapshot?.after)
    .sort((a, b) => a.benchmarkCopilotSequence - b.benchmarkCopilotSequence);

  if (eligible.length < 2) return new Map();

  const resolvedPreBaseline = resolvePreBenchmarkBaselineValue(eligible[0], preBenchmarkBaseline);

  let previousAfterCredits = resolvedPreBaseline;
  const increments = new Map();

  for (const row of eligible) {
    const afterCredits = snapshotCredits(row.copilotUsageSnapshot.after);
    const incremental = Math.max(0, Number((afterCredits - previousAfterCredits).toFixed(6)));
    previousAfterCredits = afterCredits;
    increments.set(row.agentId, incremental);
  }

  return increments;
}

module.exports = {
  CREDIT_USD_RATE,
  snapshotCredits,
  pickBillingBaseline,
  loadPreviousBenchmarkModelAfter,
  loadPreBenchmarkBillingBaseline,
  resolveEffectiveBeforeSnapshot,
  resolvePreBenchmarkBaselineValue,
  deriveSequentialIncrementalCredits,
};
