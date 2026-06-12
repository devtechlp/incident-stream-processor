const axios = require('axios');
const logger = require('../utils/logger');
const { resolveAgentEndpoint } = require('./agentRouter');

async function publish(doc) {
  const { url, key, source } = await resolveAgentEndpoint(doc);

  logger.info(
    `Routing incident ${doc._id} (${doc.serviceName ?? 'unknown'}) via ${source} → ${url}`
  );

  const response = await axios.post(url, doc, {
    headers: {
      'Content-Type': 'application/json',
      'x-functions-key': key,
    },
    timeout: 15000,
  });

  logger.info(`Incident ${doc._id} forwarded — Function responded: ${response.status}`);
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
