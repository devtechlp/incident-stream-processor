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

  let res;
  try {
    res = await axios.post(
      'https://sso.dynatrace.com/sso/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: DT_CLIENT_ID,
        client_secret: DT_CLIENT_SECRET,
        scope: 'storage:logs:read storage:buckets:read',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch (err) {
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`OAuth token request failed (${err.response?.status ?? 'no response'}): ${body} — check DT_CLIENT_ID and DT_CLIENT_SECRET`);
  }

  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 30) * 1000;
  logger.info('Dynatrace log poller: OAuth token refreshed');
  return cachedToken;
}

// Execute a DQL query on Grail. Grail may respond synchronously or return a
// requestToken for async polling — this function handles both cases.
async function executeDql(token, query, from, to) {
  let res;
  try {
    res = await axios.post(
      `${DT_ENV_URL}/platform/storage/query/v1/query:execute`,
      { query, defaultTimeframeStart: from, defaultTimeframeEnd: to },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`DQL execute failed (${err.response?.status ?? 'no response'}): ${body}`);
  }

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

// ── Log format detection ─────────────────────────────────────────────────────

// Java structured log: "2026-05-16T... level=ERROR service=... msg=..."
const JAVA_LOG = /\bservice=([a-zA-Z0-9_-]+)/;
// .NET console log: "fail: Namespace.Class[EventId]"
const DOTNET_LOG = /^(fail|crit|warn|info|dbug|trce):\s+([\w.]+)\[(\d+)\]/m;

function isJavaLog(logText) { return JAVA_LOG.test(logText); }
function isDotnetLog(logText) { return DOTNET_LOG.test(logText); }

// ── Log record helpers ───────────────────────────────────────────────────────

function extractServiceFromLog(logText) {
  // Java: service=incident-java-exception-service
  const javaMatch = logText.match(/\bservice=([a-zA-Z0-9_-]+)/);
  if (javaMatch) return javaMatch[1];

  // .NET: root namespace segment of "Namespace.Class[0]" — e.g. "IncidentDotnetExceptionService"
  const dotnetMatch = logText.match(DOTNET_LOG);
  if (dotnetMatch) return dotnetMatch[2].split('.')[0];

  return null;
}

function extractLoggerFromLog(logText) {
  // Java: logger=com.example.ClassName  →  last segment
  const javaMatch = logText.match(/\blogger=([a-zA-Z0-9._-]+)/);
  if (javaMatch) {
    const parts = javaMatch[1].split('.');
    return parts[parts.length - 1];
  }

  // .NET: last segment of the category name — e.g. "IncidentService"
  const dotnetMatch = logText.match(DOTNET_LOG);
  if (dotnetMatch) {
    const parts = dotnetMatch[2].split('.');
    return parts[parts.length - 1];
  }

  return null;
}

function extractErrorFromLog(logText) {
  // Java: prefer error= field, fall back to msg=
  if (isJavaLog(logText)) {
    const errorMatch = logText.match(/\berror=(.+)$/m);
    if (errorMatch) return errorMatch[1].trim();
    const msgMatch = logText.match(/\bmsg=(.+)$/m);
    if (msgMatch) return msgMatch[1].trim();
  }

  // .NET: optional message line between the category header and the stack trace
  // Pattern: "fail: Category[0]\n      <message>\n         at ..."
  if (isDotnetLog(logText)) {
    const msgMatch = logText.match(/^(?:fail|crit):\s+[^\n]+\n[ \t]+([^\s\tat][^\n]+)/m);
    if (msgMatch) return msgMatch[1].trim();
  }

  return null;
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

  // No time range in DQL — Grail's from:/to: syntax doesn't reliably bound the window.
  // Fetch latest 100 ERROR logs and filter by lastPollTime in JS instead.
  const query = `fetch logs | filter contains(content, "level=ERROR") | sort timestamp desc | limit 100`;

  logger.info(`Dynatrace log poller: querying ERROR logs since ${lastPollTime}`);
  const records = await executeDql(token, query, null, null);

  // Keep only records newer than the last poll — MongoDB deduplication handles edge cases
  return records.filter((r) => new Date(r.timestamp) > new Date(lastPollTime));
}

async function poll() {
  try {
    const records = await fetchErrorLogs();

    logger.info(`Dynatrace log poller: found ${records.length} record(s) from DQL`);

    if (records.length === 0) {
      logger.info('Dynatrace log poller: no new ERROR logs');
      lastPollTime = new Date().toISOString();
      return;
    }

    const db = await getDB();
    const col = db.collection(MONGO_COLLECTION);

    for (const record of records) {
      const doc = mapLogToIncidentDocument(record);
      logger.info(`Dynatrace log poller: upserting — service: ${doc.applicationName}, occurredAt: ${doc.occurredAt}`);

      // Deduplicate: same service + same timestamp won't insert twice
      const result = await col.updateOne(
        { applicationName: doc.applicationName, occurredAt: doc.occurredAt },
        { $setOnInsert: doc },
        { upsert: true }
      );
      logger.info(`Dynatrace log poller: upsert result — matched: ${result.matchedCount}, upserted: ${result.upsertedCount}`);
    }

    logger.info(`Dynatrace log poller: upserted ${records.length} ERROR logs`);
    lastPollTime = new Date().toISOString();
  } catch (err) {
    logger.error(`Dynatrace log poller error: ${err.message}`);
  }
}

async function debugSampleRecord() {
  try {
    const token = await getOAuthToken();

    // Test 1 — absolute simplest DQL, no time range, no filter
    logger.info('Dynatrace log poller [debug]: trying fetch logs | limit 1 ...');
    const r1 = await executeDql(token, `fetch logs | limit 1`, null, null);
    if (r1.length > 0) {
      logger.info(`Dynatrace log poller [debug] fetch logs | limit 1 result:\n${JSON.stringify(r1[0], null, 2)}`);
      return;
    }
    logger.info('Dynatrace log poller [debug]: fetch logs | limit 1 returned nothing — trying classic API ...');

    // Test 2 — classic /api/v2/logs/search with Bearer token (fallback)
    const res = await axios.get(`${DT_ENV_URL}/api/v2/logs/search`, {
      params: { limit: 1 },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.data?.results?.length > 0) {
      logger.info(`Dynatrace log poller [debug] classic API result:\n${JSON.stringify(res.data.results[0], null, 2)}`);
    } else {
      logger.info('Dynatrace log poller [debug]: classic API also returned nothing');
    }
  } catch (err) {
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Dynatrace log poller [debug] failed (${err.response?.status ?? 'no response'}): ${body}`);
  }
}

function start() {
  if (!DT_ENV_URL || !DT_CLIENT_ID || !DT_CLIENT_SECRET) {
    logger.warn('Dynatrace log poller: DT_ENV_URL / DT_CLIENT_ID / DT_CLIENT_SECRET not set — poller disabled');
    return;
  }
  logger.info('Dynatrace log poller started (Grail / DQL mode)');
  debugSampleRecord();
  setInterval(debugSampleRecord, 5 * 60 * 1000); // repeat every 5 min until we see a record
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

module.exports = { start };
