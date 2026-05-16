const axios = require('axios');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');

const DT_ENV_URL = process.env.DT_ENV_URL;           // https://abc123.apps.dynatrace.com
const DT_CLIENT_ID = process.env.DT_CLIENT_ID;       // OAuth client ID
const DT_CLIENT_SECRET = process.env.DT_CLIENT_SECRET; // OAuth client secret
const POLL_INTERVAL_MS = 60 * 1000;
const MONGO_COLLECTION = process.env.MONGO_COLLECTION;

let lastPollTime = new Date(Date.now() - POLL_INTERVAL_MS).toISOString();

// Cached OAuth token so we don't request a new one every poll cycle
let cachedToken = null;
let tokenExpiresAt = 0;

async function getOAuthToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await axios.post(
    'https://sso.dynatrace.com/sso/oauth2/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: DT_CLIENT_ID,
      client_secret: DT_CLIENT_SECRET,
      scope: 'storage:logs:read',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  cachedToken = res.data.access_token;
  // Refresh 30 s before actual expiry to avoid using a stale token
  tokenExpiresAt = Date.now() + (res.data.expires_in - 30) * 1000;
  logger.info('Dynatrace log poller: OAuth token refreshed');
  return cachedToken;
}

// Execute a DQL query on Grail. Grail may respond synchronously or return a
// requestToken for async polling — this function handles both cases.
async function executeDql(token, query, from, to) {
  const res = await axios.post(
    `${DT_ENV_URL}/platform/storage/query/v1/query:execute`,
    {
      query,
      defaultTimeframeStart: from,
      defaultTimeframeEnd: to,
      requestTimeoutMilliseconds: 10000,
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  if (res.data.state === 'SUCCEEDED') {
    return res.data.result?.records || [];
  }

  // Async path — poll until SUCCEEDED or terminal state
  const requestToken = res.data.requestToken;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));

    const poll = await axios.get(
      `${DT_ENV_URL}/platform/storage/query/v1/query:poll`,
      {
        params: { 'request-token': requestToken },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (poll.data.state === 'SUCCEEDED') return poll.data.result?.records || [];
    if (poll.data.state === 'FAILED' || poll.data.state === 'CANCELLED') {
      throw new Error(`DQL query ended with state: ${poll.data.state}`);
    }
  }

  throw new Error('DQL query did not complete within 10 seconds');
}

// ── Log record helpers ───────────────────────────────────────────────────────

function extractServiceFromLog(logText) {
  const match = logText.match(/service=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function extractLoggerFromLog(logText) {
  const match = logText.match(/logger=([a-zA-Z0-9._-]+)/);
  if (!match) return null;
  const parts = match[1].split('.');
  return parts[parts.length - 1];
}

function extractErrorFromLog(logText) {
  const match = logText.match(/(?:error|msg)=(.+)$/m);
  return match ? match[1].trim() : null;
}

// Map a Grail log record to the incident document schema.
// Grail field names differ slightly from the classic API:
//   dt.trace_id (Grail) vs trace_id (classic)
function mapLogToIncidentDocument(record) {
  const logText = record.content || '';

  return {
    errorId:          Date.now() + Math.random(),
    traceId:          record['dt.trace_id'] || record['trace_id'] || '',
    applicationName:  extractServiceFromLog(logText) || record['service.name'] || 'unknown',
    hostName:         record['host.name'] || 'unknown',
    pid:              0,
    exceptionType:    'dynatrace.ERROR.LOG',
    exceptionMessage: extractErrorFromLog(logText) || logText.substring(0, 200),
    stackTrace:       logText,
    causedByChain:    [extractErrorFromLog(logText) || ''],
    context: {
      source:      'dynatrace-log',
      loggerClass: extractLoggerFromLog(logText),
      rawLog:      logText,
      status:      record.status,
      timestamp:   record.timestamp,
    },
    occurredAt:    new Date(record.timestamp),
    healingStatus: 'PENDING',
    _class:        'com.dynatrace.log.LogEntry',
  };
}

// ── Poll cycle ───────────────────────────────────────────────────────────────

async function fetchErrorLogs() {
  const token = await getOAuthToken();
  const from = lastPollTime;
  const to = new Date().toISOString();

  // DQL: fetch only ERROR level logs in the poll window
  const query = `fetch logs | filter status == "ERROR"`;

  logger.info(`Dynatrace log poller: querying ERROR logs from ${from} to ${to}`);
  return executeDql(token, query, from, to);
}

async function poll() {
  try {
    const records = await fetchErrorLogs();

    if (records.length === 0) {
      logger.info('Dynatrace log poller: no new ERROR logs');
      lastPollTime = new Date().toISOString();
      return;
    }

    const db = await getDB();
    const col = db.collection(MONGO_COLLECTION);

    for (const record of records) {
      const doc = mapLogToIncidentDocument(record);

      // Deduplicate: same service + same timestamp won't insert twice
      await col.updateOne(
        { applicationName: doc.applicationName, occurredAt: doc.occurredAt },
        { $setOnInsert: doc },
        { upsert: true }
      );
    }

    logger.info(`Dynatrace log poller: upserted ${records.length} ERROR logs`);
    lastPollTime = new Date().toISOString();
  } catch (err) {
    logger.error(`Dynatrace log poller error: ${err.message}`);
  }
}

function start() {
  if (!DT_ENV_URL || !DT_CLIENT_ID || !DT_CLIENT_SECRET) {
    logger.warn('Dynatrace log poller: DT_ENV_URL / DT_CLIENT_ID / DT_CLIENT_SECRET not set — poller disabled');
    return;
  }
  logger.info('Dynatrace log poller started (Grail / DQL mode)');
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

module.exports = { start };
