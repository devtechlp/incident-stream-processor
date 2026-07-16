/**
 * Unit tests for GitHub AI credits parsing and snapshot diff.
 * Run: node test/github-ai-credits.test.js
 */

const assert = require('assert');
const {
  parseUsageItems,
  diffUsageSnapshots,
  CREDIT_USD_RATE,
  shouldPreferUserBilling,
  isCompatibleBillingSnapshot,
} = require('../services/githubAiCredits');

function testParseUsageItems() {
  const items = [
    { unitType: 'AI Credits', netQuantity: 12.5, netAmount: 0.125, model: 'claude-sonnet-5', product: 'copilot' },
    { unitType: 'Input Tokens', netQuantity: 40000, model: 'claude-sonnet-5' },
    { unitType: 'Output Tokens', netQuantity: 8000, model: 'claude-sonnet-5' },
    { unitType: 'Cached Input Tokens', netQuantity: 2000, model: 'claude-sonnet-5' },
  ];

  const parsed = parseUsageItems(items);
  assert.strictEqual(parsed.aiCredits, 12.5);
  assert.strictEqual(parsed.costUsd, 0.125);
  assert.strictEqual(parsed.inputTokens, 40000);
  assert.strictEqual(parsed.outputTokens, 8000);
  assert.strictEqual(parsed.cachedTokens, 2000);
  assert.deepStrictEqual(parsed.models, ['claude-sonnet-5']);
}

function testDiffUsageSnapshots() {
  const before = parseUsageItems([
    { unitType: 'AI Credits', netQuantity: 10, netAmount: 0.1 },
    { unitType: 'Input Tokens', netQuantity: 100000 },
    { unitType: 'Output Tokens', netQuantity: 20000 },
  ]);
  const after = parseUsageItems([
    { unitType: 'AI Credits', netQuantity: 15.5, netAmount: 0.155 },
    { unitType: 'Input Tokens', netQuantity: 145000 },
    { unitType: 'Output Tokens', netQuantity: 28000 },
  ]);

  const delta = diffUsageSnapshots(before, after);
  assert.strictEqual(delta.deltaCredits, 5.5);
  assert.strictEqual(delta.deltaCostUsd, 0.055);
  assert.strictEqual(delta.deltaInputTokens, 45000);
  assert.strictEqual(delta.deltaOutputTokens, 8000);
  assert.strictEqual(delta.creditUsdRate, CREDIT_USD_RATE);
}

function testDiffFromCreditsOnly() {
  const before = { aiCredits: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  const after = { aiCredits: 3, costUsd: 0, inputTokens: 5000, outputTokens: 1200 };
  const delta = diffUsageSnapshots(before, after);
  assert.strictEqual(delta.deltaCredits, 3);
  assert.strictEqual(delta.deltaCostUsd, 0.03);
}

function testGrossWhenNetIsZero() {
  const items = [
    {
      unitType: 'ai-credits',
      grossQuantity: 42,
      grossAmount: 0.42,
      netQuantity: 0,
      netAmount: 0,
      model: 'Auto: Claude Sonnet 4.6',
      product: 'Copilot',
    },
  ];
  const parsed = parseUsageItems(items);
  assert.strictEqual(parsed.aiCredits, 42);
  assert.strictEqual(parsed.costUsd, 0.42);
}

function testShouldPreferUserBilling() {
  const prevAccount = process.env.COPILOT_BILLING_ACCOUNT;
  const prevUser = process.env.COPILOT_BILLING_USER;
  try {
    delete process.env.COPILOT_BILLING_ACCOUNT;
    process.env.COPILOT_BILLING_USER = 'test-user';
    assert.strictEqual(shouldPreferUserBilling(), true);
    process.env.COPILOT_BILLING_ACCOUNT = 'org';
    assert.strictEqual(shouldPreferUserBilling(), false);
  } finally {
    if (prevAccount == null) delete process.env.COPILOT_BILLING_ACCOUNT;
    else process.env.COPILOT_BILLING_ACCOUNT = prevAccount;
    if (prevUser == null) delete process.env.COPILOT_BILLING_USER;
    else process.env.COPILOT_BILLING_USER = prevUser;
  }
}

function testCompatibleBillingSnapshot() {
  assert.strictEqual(
    isCompatibleBillingSnapshot({ billingAccount: 'org' }, { billingAccount: 'user' }),
    false,
  );
  assert.strictEqual(
    isCompatibleBillingSnapshot({ billingAccount: 'user' }, { billingAccount: 'user' }),
    true,
  );
  assert.strictEqual(isCompatibleBillingSnapshot(null, { billingAccount: 'user' }), true);
}

function run() {
  testParseUsageItems();
  testDiffUsageSnapshots();
  testDiffFromCreditsOnly();
  testGrossWhenNetIsZero();
  testShouldPreferUserBilling();
  testCompatibleBillingSnapshot();
  console.log('github-ai-credits.test.js — all passed');
}

run();
