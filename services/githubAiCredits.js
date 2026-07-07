/**
 * GitHub org AI credit usage — billing API client.
 * 1 AI credit = $0.01 USD (GitHub usage-based Copilot billing).
 *
 * IMPORTANT: Copilot AI credits come from GET .../ai_credit/usage only.
 * Do NOT use usage/summary + repository — that returns Actions minutes, not credits.
 *
 * Requires GITHUB_TOKEN with org billing read (manage_billing:copilot) and org admin.
 */

const axios = require('axios');
const logger = require('../utils/logger');

const CREDIT_USD_RATE = Number(process.env.COPILOT_CREDIT_USD_RATE || 0.01);
const USE_GROSS = (process.env.COPILOT_BILLING_USE_GROSS || 'true').toLowerCase() !== 'false';
const AI_CREDIT_URL = (org) =>
  `https://api.github.com/organizations/${org}/settings/billing/ai_credit/usage`;

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function utcDateParts(date = new Date()) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function normalizeUnitType(unitType) {
  return String(unitType || '').toLowerCase().replace(/_/g, '-');
}

function quantityField(item) {
  if (USE_GROSS) {
    return Number(item.grossQuantity ?? item.netQuantity ?? 0);
  }
  return Number(item.netQuantity ?? item.grossQuantity ?? 0);
}

function amountField(item) {
  if (USE_GROSS) {
    return Number(item.grossAmount ?? item.netAmount ?? 0);
  }
  return Number(item.netAmount ?? item.grossAmount ?? 0);
}

/**
 * Parse GitHub ai_credit/usage items into credits, USD, and token breakdown.
 */
function parseUsageItems(usageItems = []) {
  let aiCredits = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  const models = new Set();
  const products = new Set();

  for (const item of usageItems) {
    const unit = normalizeUnitType(item.unitType);
    const qty = quantityField(item);
    const amount = amountField(item);

    if (item.model) models.add(item.model);
    if (item.product) products.add(item.product);

    if (unit.includes('credit') || unit === 'ai-credits') {
      aiCredits += qty;
      costUsd += amount;
    } else if (unit.includes('cached') && unit.includes('token')) {
      cachedTokens += qty;
    } else if (unit.includes('input') && unit.includes('token')) {
      inputTokens += qty;
    } else if (unit.includes('output') && unit.includes('token')) {
      outputTokens += qty;
    } else if (unit.includes('token')) {
      inputTokens += qty;
    }
  }

  if (costUsd <= 0 && aiCredits > 0) {
    costUsd = aiCredits * CREDIT_USD_RATE;
  }

  return {
    aiCredits: Number(aiCredits.toFixed(6)),
    costUsd: Number(costUsd.toFixed(6)),
    inputTokens: Math.round(inputTokens),
    outputTokens: Math.round(outputTokens),
    cachedTokens: Math.round(cachedTokens),
    models: [...models],
    products: [...products],
    usageItemsCount: usageItems.length,
    usageItems,
    quantityBasis: USE_GROSS ? 'gross' : 'net',
  };
}

async function fetchJson(url, params = {}) {
  const { data } = await axios.get(url, {
    headers: githubHeaders(),
    params,
    timeout: 20000,
  });
  return data;
}

function resolveBillingModel(explicitModel) {
  if (explicitModel) return explicitModel;
  if (process.env.COPILOT_BILLING_MODEL) return process.env.COPILOT_BILLING_MODEL;
  return undefined;
}

function resolveBillingProduct(explicitProduct) {
  if (explicitProduct) return explicitProduct;
  if (process.env.COPILOT_BILLING_PRODUCT) return process.env.COPILOT_BILLING_PRODUCT;
  return 'Copilot';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch org AI credit usage for a UTC day (org-level — repository is metadata only).
 */
async function fetchOrgAiCreditUsage({
  org,
  repository,
  product,
  model,
  at = new Date(),
} = {}) {
  const githubOrg = org || process.env.GITHUB_ORG;
  if (!githubOrg) throw new Error('GITHUB_ORG is not configured');

  const { year, month, day } = utcDateParts(at);
  const params = { year, month, day };

  const billingProduct = resolveBillingProduct(product);
  if (billingProduct) params.product = billingProduct;

  const billingModel = resolveBillingModel(model);
  if (billingModel) params.model = billingModel;

  const data = await fetchJson(AI_CREDIT_URL(githubOrg), params);
  const parsed = parseUsageItems(data?.usageItems || []);

  return {
    ...parsed,
    capturedAt: new Date().toISOString(),
    org: githubOrg,
    repository: repository || null,
    product: billingProduct || null,
    model: billingModel || null,
    timePeriod: data?.timePeriod || { year, month, day },
    source: 'ai_credit/usage',
  };
}

async function fetchOrgAiCreditUsageWithRetry(options = {}) {
  const attempts = Number(process.env.COPILOT_BILLING_RETRY_ATTEMPTS || 3);
  const delayMs = Number(process.env.COPILOT_BILLING_RETRY_MS || 90000);
  let last;

  for (let i = 1; i <= attempts; i += 1) {
    last = await fetchOrgAiCreditUsage(options);
    if (last.usageItemsCount > 0 || last.aiCredits > 0) {
      return last;
    }
    if (i < attempts) {
      logger.info(`AI credits API empty (attempt ${i}/${attempts}) — retry in ${Math.round(delayMs / 1000)}s`);
      await sleep(delayMs);
    }
  }

  return last;
}

function diffUsageSnapshots(before, after) {
  const deltaCredits = Math.max(0, (after?.aiCredits || 0) - (before?.aiCredits || 0));
  const deltaCostUsd = Math.max(0, (after?.costUsd || 0) - (before?.costUsd || 0));
  const resolvedCostUsd = deltaCostUsd > 0 ? deltaCostUsd : deltaCredits * CREDIT_USD_RATE;

  return {
    deltaCredits: Number(deltaCredits.toFixed(6)),
    deltaCostUsd: Number(resolvedCostUsd.toFixed(6)),
    deltaInputTokens: Math.max(0, (after?.inputTokens || 0) - (before?.inputTokens || 0)),
    deltaOutputTokens: Math.max(0, (after?.outputTokens || 0) - (before?.outputTokens || 0)),
    deltaCachedTokens: Math.max(0, (after?.cachedTokens || 0) - (before?.cachedTokens || 0)),
    creditUsdRate: CREDIT_USD_RATE,
    quantityBasis: after?.quantityBasis || before?.quantityBasis || (USE_GROSS ? 'gross' : 'net'),
    models: [...new Set([...(before?.models || []), ...(after?.models || [])])],
  };
}

function hasBillableDelta(delta) {
  if (!delta) return false;
  return (
    delta.deltaCredits > 0
    || delta.deltaInputTokens > 0
    || delta.deltaOutputTokens > 0
    || delta.deltaCachedTokens > 0
  );
}

function isAiCreditsBillingEnabled() {
  const mode = (process.env.COPILOT_BILLING_MODE || 'ai_credits').toLowerCase();
  return mode === 'ai_credits' || mode === 'credits';
}

module.exports = {
  CREDIT_USD_RATE,
  USE_GROSS,
  parseUsageItems,
  fetchOrgAiCreditUsage,
  fetchOrgAiCreditUsageWithRetry,
  diffUsageSnapshots,
  hasBillableDelta,
  isAiCreditsBillingEnabled,
};
