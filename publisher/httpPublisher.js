const axios = require('axios');
const logger = require('../utils/logger');
const { resolveAgentEndpoint, resolveServiceName } = require('./agentRouter');
const { claimIncidentForDispatch, releaseDispatchClaim } = require('./dispatchClaim');

async function publish(doc) {
  const { url, key, source } = await resolveAgentEndpoint(doc);
  const serviceName = resolveServiceName(doc);

  const claimed = await claimIncidentForDispatch(doc, url);
  if (!claimed) {
    logger.info(
      `Skipping incident ${doc._id} (${serviceName}) — already dispatched or no longer PENDING`
    );
    return { skipped: true, reason: 'already_dispatched' };
  }

  logger.info(
    `Routing incident ${doc._id} (${serviceName}) via ${source} → ${url}`
  );

  try {
    const response = await axios.post(url, doc, {
      headers: {
        'Content-Type': 'application/json',
        'x-functions-key': key,
      },
      timeout: 15000,
    });

    logger.info(`Incident ${doc._id} forwarded — Function responded: ${response.status}`);
    return { skipped: false, status: response.status };
  } catch (err) {
    await releaseDispatchClaim(doc, url);
    throw err;
  }
}

function formatAxiosError(err) {
  if (err.response) {
    return `HTTP ${err.response.status} ${err.response.statusText} — body: ${JSON.stringify(err.response.data)}`;
  } else if (err.request) {
    return `No response received — code: ${err.code || 'unknown'}, message: ${err.message}`;
  }
  return err.message || String(err);
}

module.exports = { publish, formatAxiosError };
