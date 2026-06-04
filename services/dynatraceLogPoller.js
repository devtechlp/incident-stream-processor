const axios = require('axios');
const { BlobServiceClient } = require('@azure/storage-blob');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');

// ── Config ────────────────────────────────────────────────────────────────────
const DT_ENV_URL       = process.env.DT_ENV_URL;
const DT_CLIENT_ID     = process.env.DT_CLIENT_ID;
const DT_CLIENT_SECRET = process.env.DT_CLIENT_SECRET;
const POLL_INTERVAL_MS = 60 * 1000;
const CHECKPOINT_LOOKBACK_MS = parseInt(process.env.POLLER_CHECKPOINT_LOOKBACK_MS || '', 10) || 15 * 60 * 1000;
const MONGO_COLLECTION = process.env.MONGO_COLLECTION;

// Azure Blob Storage checkpoint — same pattern as dynatrace-log-forwarder
const CHECKPOINT_CONNECTION = process.env.CHECKPOINT_STORAGE_CONNECTION_STRING;
const CHECKPOINT_CONTAINER  = process.env.CHECKPOINT_CONTAINER  || 'dynatrace-poller-checkpoints';
const CHECKPOINT_BLOB       = process.env.CHECKPOINT_BLOB       || 'checkpoint.json';

// ── OAuth token (cached until 30s before expiry) ──────────────────────────────
let cachedToken    = null;
let tokenExpiresAt = 0;

async function getOAuthToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  let res;
  try {
    res = await axios.post(
      'https://sso.dynatrace.com/sso/oauth2/token',
      new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     DT_CLIENT_ID,
        client_secret: DT_CLIENT_SECRET,
        scope:         'storage:logs:read storage:buckets:read',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch (err) {
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`OAuth token request failed (${err.response?.status ?? 'no response'}): ${body}`);
  }

  cachedToken    = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 30) * 1000;
  logger.info('Dynatrace log poller: OAuth token refreshed');
  return cachedToken;
}

// ── Blob Storage checkpoint ───────────────────────────────────────────────────
function getBlobClient() {
  const service   = BlobServiceClient.fromConnectionString(CHECKPOINT_CONNECTION);
  const container = service.getContainerClient(CHECKPOINT_CONTAINER);
  return container.getBlockBlobClient(CHECKPOINT_BLOB);
}

async function readCheckpoint() {
  try {
    const blobClient = getBlobClient();
    const download   = await blobClient.download();
    const chunks     = [];
    for await (const chunk of download.readableStreamBody) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    logger.info(`Dynatrace log poller: checkpoint read — lastProcessedTime: ${parsed.lastProcessedTime}`);
    return parsed.lastProcessedTime;
  } catch {
    // No checkpoint yet — look back far enough to catch recent errors (Grail ingest delay)
    const fallback = new Date(Date.now() - CHECKPOINT_LOOKBACK_MS).toISOString();
    logger.info(`Dynatrace log poller: no checkpoint found, defaulting to ${fallback} (${CHECKPOINT_LOOKBACK_MS / 1000}s lookback)`);
    return fallback;
  }
}

async function writeCheckpoint(timestamp) {
  try {
    const blobClient = getBlobClient();
    const data       = Buffer.from(JSON.stringify({ lastProcessedTime: timestamp }));
    await blobClient.getContainerClient?.createIfNotExists?.();
    await blobClient.uploadData(data, { overwrite: true });
    logger.info(`Dynatrace log poller: checkpoint updated — ${timestamp}`);
  } catch (err) {
    logger.error(`Dynatrace log poller: failed to write checkpoint — ${err.message}`);
    throw err;
  }
}

// ── DQL execution ─────────────────────────────────────────────────────────────
async function executeDql(token, query) {
  let res;
  try {
    res = await axios.post(
      `${DT_ENV_URL}/platform/storage/query/v1/query:execute`,
      { query },
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
    await new Promise(r => setTimeout(r, 1000));
    const poll = await axios.get(
      `${DT_ENV_URL}/platform/storage/query/v1/query:poll`,
      { params: { 'request-token': requestToken }, headers: { Authorization: `Bearer ${token}` } }
    );
    if (poll.data.state === 'SUCCEEDED') return poll.data.result?.records || [];
    if (poll.data.state === 'FAILED' || poll.data.state === 'CANCELLED') {
      throw new Error(`DQL query ended with state: ${poll.data.state}`);
    }
  }
  throw new Error('DQL query did not complete within 10 seconds');
}

// ── Log record helpers ────────────────────────────────────────────────────────
function extractServiceFromLog(logText) {
  const javaMatch = logText.match(/\bservice=([a-zA-Z0-9_-]+)/);
  if (javaMatch) return javaMatch[1];
  // Spring Boot default pattern: ... ERROR ... [freight-planning-admin-service] ...
  const springMatch = logText.match(/\[([a-zA-Z0-9_-]+)\]\s*\[/);
  if (springMatch) return springMatch[1];
  const dotnetMatch = logText.match(/^(fail|crit):\s+([\w.]+)\[/m);
  if (dotnetMatch) return dotnetMatch[2].split('.')[0];
  return null;
}

function extractErrorFromLog(logText) {
  const errorMatch = logText.match(/\berror=(.+)$/m);
  if (errorMatch) return errorMatch[1].trim();
  const msgMatch = logText.match(/\bmsg=(.+)$/m);
  if (msgMatch) return msgMatch[1].trim();
  const dotnetMsg = logText.match(/^(?:fail|crit):\s+[^\n]+\n[ \t]+([^\s\tat][^\n]+)/m);
  if (dotnetMsg) return dotnetMsg[1].trim();
  return null;
}

function mapToIncidentDocument(record) {
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
      source:    'dynatrace-log-poller',
      status:    record.status,
      timestamp: record.timestamp,
    },
    occurredAt:    new Date(record.timestamp),
    healingStatus: 'PENDING',
    _class:        'com.dynatrace.log.LogEntry',
  };
}

// ── Poll cycle ────────────────────────────────────────────────────────────────
async function poll() {
  try {
    const lastProcessedTime = await readCheckpoint();
    const token             = await getOAuthToken();

    // Structured Java (level=ERROR), Spring Boot (" ERROR "), .NET (fail:/crit:)
    const query = [
      'fetch logs',
      '| filter contains(content, "level=ERROR")',
      '  or contains(content, "level=error")',
      '  or contains(content, " ERROR ")',
      '  or contains(content, "level=CRITICAL")',
      '  or contains(content, "level=FATAL")',
      '  or startsWith(content, "fail:")',
      '  or startsWith(content, "crit:")',
      '| sort timestamp asc',
      '| limit 100',
    ].join(' ');
    const records = await executeDql(token, query);

    logger.info(`Dynatrace log poller: DQL returned ${records.length} record(s)`);

    // Keep only records newer than the checkpoint
    const newRecords = records.filter(r => new Date(r.timestamp) > new Date(lastProcessedTime));
    logger.info(`Dynatrace log poller: ${newRecords.length} new record(s) after checkpoint filter`);

    if (newRecords.length === 0) {
      logger.info('Dynatrace log poller: no new ERROR logs');
      return;
    }

    const db  = await getDB();
    const col = db.collection(MONGO_COLLECTION);

    for (const record of newRecords) {
      const doc = mapToIncidentDocument(record);
      await col.updateOne(
        { applicationName: doc.applicationName, occurredAt: doc.occurredAt },
        { $setOnInsert: doc },
        { upsert: true }
      );
    }

    logger.info(`Dynatrace log poller: upserted ${newRecords.length} ERROR log(s) into MongoDB`);

    // Advance checkpoint to latest record timestamp + 1ms
    const latest = new Date(newRecords[newRecords.length - 1].timestamp);
    latest.setMilliseconds(latest.getMilliseconds() + 1);
    await writeCheckpoint(latest.toISOString());

  } catch (err) {
    logger.error(`Dynatrace log poller error: ${err.message}`);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function ensureContainer() {
  try {
    const service   = BlobServiceClient.fromConnectionString(CHECKPOINT_CONNECTION);
    const container = service.getContainerClient(CHECKPOINT_CONTAINER);
    await container.createIfNotExists();
    logger.info(`Dynatrace log poller: checkpoint container '${CHECKPOINT_CONTAINER}' ready`);
  } catch (err) {
    logger.error(`Dynatrace log poller: failed to create checkpoint container — ${err.message}`);
    throw err;
  }
}

function start() {
  if (!DT_ENV_URL || !DT_CLIENT_ID || !DT_CLIENT_SECRET) {
    logger.warn('Dynatrace log poller: DT_ENV_URL / DT_CLIENT_ID / DT_CLIENT_SECRET not set — poller disabled');
    return;
  }
  if (!CHECKPOINT_CONNECTION) {
    logger.warn('Dynatrace log poller: CHECKPOINT_STORAGE_CONNECTION_STRING not set — poller disabled');
    return;
  }

  logger.info('Dynatrace log poller starting...');
  ensureContainer()
    .then(() => {
      poll();
      setInterval(poll, POLL_INTERVAL_MS);
    })
    .catch(err => logger.error(`Dynatrace log poller failed to start: ${err.message}`));
}

module.exports = { start };
