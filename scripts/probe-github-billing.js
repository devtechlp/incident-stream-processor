/**
 * Probe GitHub billing API responses (debug zero credits).
 * Run: node scripts/probe-github-billing.js
 */
require('dotenv').config();
const axios = require('axios');

const org = process.env.GITHUB_ORG || 'devtechlp';
const repo = process.argv[2] || 'devtechlp/freight-planning-admin-service';
const token = process.env.GITHUB_TOKEN;
const now = new Date();
const params = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function get(label, url, query = {}) {
  try {
    const { data, status } = await axios.get(url, { headers, params: { ...params, ...query }, timeout: 20000 });
    const items = data?.usageItems || [];
    console.log(`\n=== ${label} (${status}) ===`);
    console.log('timePeriod:', data?.timePeriod);
    console.log('usageItems count:', items.length);
    if (items.length) {
      console.log('first item:', JSON.stringify(items[0], null, 2));
      const credits = items.filter((i) => String(i.unitType || '').toLowerCase().includes('credit'));
      const gross = credits.reduce((s, i) => s + (i.grossQuantity || 0), 0);
      const net = credits.reduce((s, i) => s + (i.netQuantity || 0), 0);
      console.log('credit items:', credits.length, 'grossQty sum:', gross, 'netQty sum:', net);
    }
    return data;
  } catch (err) {
    console.log(`\n=== ${label} FAILED ===`);
    console.log(err.response?.status, err.response?.data || err.message);
    return null;
  }
}

async function main() {
  if (!token) throw new Error('GITHUB_TOKEN missing');
  const monthParams = { year: params.year, month: params.month };
  await get('users/{user}/ai_credit/usage', `https://api.github.com/users/${process.env.COPILOT_BILLING_USER || 'lavanyapamula-lp'}/settings/billing/ai_credit/usage`, {
    product: 'copilot',
  });
  await get('ai_credit/usage (org day)', `https://api.github.com/organizations/${org}/settings/billing/ai_credit/usage`, {
    product: 'copilot',
  });
  await get('ai_credit/usage (org month)', `https://api.github.com/organizations/${org}/settings/billing/ai_credit/usage`, {
    product: 'copilot',
    ...monthParams,
  });
  await get('ai_credit/usage (no filters month)', `https://api.github.com/organizations/${org}/settings/billing/ai_credit/usage`, monthParams);
  await get('ai_credit/usage + model filter', `https://api.github.com/organizations/${org}/settings/billing/ai_credit/usage`, {
    product: 'copilot',
    model: process.env.COPILOT_MODEL || 'claude-sonnet-5',
    ...monthParams,
  });
  await get('usage/summary + repository', `https://api.github.com/organizations/${org}/settings/billing/usage/summary`, {
    repository: repo,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
