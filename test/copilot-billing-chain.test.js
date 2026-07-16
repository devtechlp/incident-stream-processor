const assert = require('assert');
const {
  snapshotCredits,
  pickBillingBaseline,
  deriveSequentialIncrementalCredits,
} = require('../services/copilotBillingChain');

function testSnapshotCredits() {
  assert.strictEqual(snapshotCredits({ aiCredits: 218 }), 218);
  assert.strictEqual(snapshotCredits({ costUsd: 2.58 }), 258);
  assert.strictEqual(snapshotCredits(null), 0);
}

function testPickBillingBaseline() {
  const issueBefore = { aiCredits: 0, costUsd: 0 };
  const chainedBefore = { aiCredits: 218, costUsd: 2.18 };
  const picked = pickBillingBaseline(chainedBefore, issueBefore);
  assert.strictEqual(picked.aiCredits, 218);
}

function testDeriveSequentialIncrementalCreditsFromZero() {
  const rows = [
    {
      agentId: 'copilot:claude-sonnet-5',
      benchmarkCopilotSequence: 0,
      copilotUsageSnapshot: { after: { aiCredits: 218 } },
    },
    {
      agentId: 'copilot:gpt-5.4',
      benchmarkCopilotSequence: 1,
      copilotUsageSnapshot: { after: { aiCredits: 258 } },
    },
    {
      agentId: 'copilot:mai-code-1-flash',
      benchmarkCopilotSequence: 2,
      copilotUsageSnapshot: { after: { aiCredits: 290 } },
    },
  ];

  const increments = deriveSequentialIncrementalCredits(rows);
  assert.strictEqual(increments.get('copilot:claude-sonnet-5'), 218);
  assert.strictEqual(increments.get('copilot:gpt-5.4'), 40);
  assert.strictEqual(increments.get('copilot:mai-code-1-flash'), 32);
}

function testDeriveSequentialIncrementalCreditsWithRunStartBaseline() {
  const rows = [
    {
      agentId: 'copilot:claude-sonnet-5',
      benchmarkCopilotSequence: 0,
      preBenchmarkBaselineCredits: 158.66333,
      copilotUsageSnapshot: { after: { aiCredits: 218 } },
    },
    {
      agentId: 'copilot:gpt-5.4',
      benchmarkCopilotSequence: 1,
      copilotUsageSnapshot: { after: { aiCredits: 258 } },
    },
    {
      agentId: 'copilot:mai-code-1-flash',
      benchmarkCopilotSequence: 2,
      copilotUsageSnapshot: { after: { aiCredits: 290 } },
    },
  ];

  const increments = deriveSequentialIncrementalCredits(rows);
  assert.ok(Math.abs(increments.get('copilot:claude-sonnet-5') - 59.34) < 0.1);
  assert.strictEqual(increments.get('copilot:gpt-5.4'), 40);
  assert.strictEqual(increments.get('copilot:mai-code-1-flash'), 32);

  const total = [...increments.values()].reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 131.34) < 0.2);
}

function run() {
  testSnapshotCredits();
  testPickBillingBaseline();
  testDeriveSequentialIncrementalCreditsFromZero();
  testDeriveSequentialIncrementalCreditsWithRunStartBaseline();
  console.log('copilot-billing-chain.test.js — all passed');
}

run();
