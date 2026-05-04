const axios = require('axios');
const logger = require('../utils/logger');

async function publish(doc) {
  const url = process.env.FUNCTION_APP_URL;

  if (!url) {
    throw new Error('FUNCTION_APP_URL is not set — should be your Azure Function HTTP trigger URL');
  }

  // Send the full incident document to the Function App
  const response = await axios.post(url, doc, {
    headers: {
      'Content-Type': 'application/json',
      // Function App key for auth (set in Azure portal)
      'x-functions-key': process.env.FUNCTION_APP_KEY || '',
    },
    // Function responds 202 immediately — 15s is plenty
    timeout: 15000,
  });

  logger.info(`Incident ${doc._id} forwarded — Function responded: ${response.status}`);
}

function formatAxiosError(err) {
  if (err.response) {
    // Server responded with a non-2xx status
    return `HTTP ${err.response.status} ${err.response.statusText} — body: ${JSON.stringify(err.response.data)}`;
  } else if (err.request) {
    // No response received (connection refused, timeout, etc.)
    return `No response received — code: ${err.code || 'unknown'}, message: ${err.message}`;
  }
  return err.message || String(err);
}

module.exports = { publish, formatAxiosError };
