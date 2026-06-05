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

// ── Error signature for deduplication ────────────────────────────────────────
// Extract a unique signature for this error: exceptionType + file:line
// Used to deduplicate incidents - same bug should create ONE incident, not many
function extractErrorSignature(logText) {
  // Extract exception type
  let exceptionType = 'UnknownException';
  
  // Java: java.lang.NullPointerException or NullPointerException
  const javaException = logText.match(/\b([A-Z]\w+(?:Exception|Error))\b/);
  if (javaException) {
    exceptionType = javaException[1];
  }
  
  // .NET: System.NullReferenceException
  const dotnetException = logText.match(/\b(System\.\w+(?:Exception))\b/);
  if (dotnetException) {
    exceptionType = dotnetException[1].split('.').pop();
  }
  
  // Extract failing file + line from first app stack trace
  let failingLocation = '';
  
  // Java: at com.freightplanning.admin.service.DriverService.method(DriverService.java:135)
  const javaFrame = logText.match(/\bat\s+([\w$.]+)\(([\w]+\.java):(\d+)\)/);
  if (javaFrame) {
    // Skip JDK/framework frames
    const fullClass = javaFrame[1];
    if (!/^(java\.|javax\.|sun\.|com\.sun\.|org\.springframework\.|org\.apache\.)/.test(fullClass)) {
      const fileName = javaFrame[2];
      const lineNumber = javaFrame[3];
      failingLocation = `${fileName}:${lineNumber}`;
    }
  }
  
  // .NET: at Namespace.Class.Method() in /path/File.cs:line 42
  if (!failingLocation) {
    const dotnetFrame = logText.match(/\bat\s+(.+?)\s+in\s+(.+\.cs):line\s+(\d+)/i);
    if (dotnetFrame) {
      const filePath = dotnetFrame[2];
      const fileName = filePath.split(/[\\/]/).pop();
      const lineNumber = dotnetFrame[3];
      failingLocation = `${fileName}:${lineNumber}`;
    }
  }
  
  // Python: File "/path/file.py", line 42
  if (!failingLocation) {
    const pythonFrames = [...logText.matchAll(/File "(.+\.py)", line (\d+)/g)];
    if (pythonFrames.length > 0) {
      // Use last frame (actual crash site)
      const lastFrame = pythonFrames[pythonFrames.length - 1];
      const filePath = lastFrame[1];
      const fileName = filePath.split(/[\\/]/).pop();
      const lineNumber = lastFrame[2];
      failingLocation = `${fileName}:${lineNumber}`;
    }
  }
  
  // If we couldn't extract location, use first line of error message as fallback
  if (!failingLocation) {
    const firstLine = logText.split('\n')[0].substring(0, 100);
    failingLocation = firstLine.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
  }
  
  return `${exceptionType}:${failingLocation}`;
}

// ── Incident filtering ───────────────────────────────────────────────────────
// Returns true if this error represents a business/validation exception (4xx)
// that should NOT create an incident. Only 5xx server errors create incidents.
// 
// GENERIC APPROACH: Uses HTTP status codes - works for ANY application.
// - 4xx (400-499) = Client/Business error = Skip (validation, not found, etc.)
// - 5xx (500-599) = Server error = Create incident (bugs, crashes, etc.)
// - No status code = Create incident (safer default for unexpected formats)
function isExpectedException(logText) {
  if (!logText) return false;
  
  // Try to extract HTTP status code from various log formats
  // Supports: Spring Boot, .NET, Python Flask/Django, Node.js Express, etc.
  
  const statusPatterns = [
    // Spring Boot: "Status: 404" or "status=404" or "status code: 404"
    /\b(?:status|Status|STATUS)[\s:=]+(\d{3})\b/i,
    // .NET: "StatusCode: 404" or "Status Code: 404"
    /\bStatus\s*Code[\s:=]+(\d{3})\b/i,
    // Generic: "404 Not Found" or "Error 404" at line start
    /^(?:Error\s+)?(\d{3})\s+(?:Error|Not Found|Bad Request|Internal Server|Service Unavailable)/im,
    // ResponseEntity/HttpStatus in logs: "returning status 404"
    /\breturning\s+(?:status\s+)?(\d{3})\b/i,
  ];
  
  for (const pattern of statusPatterns) {
    const match = logText.match(pattern);
    if (match) {
      const statusCode = parseInt(match[1], 10);
      
      // Validate it's a real HTTP status code
      if (statusCode >= 100 && statusCode < 600) {
        // 4xx = Client/Business error = Skip
        if (statusCode >= 400 && statusCode < 500) {
          return true;
        }
        // 5xx = Server error = Create incident
        if (statusCode >= 500 && statusCode < 600) {
          return false;
        }
      }
    }
  }
  
  // No status code found - check for explicit error responses without stack traces
  // These are typically handled business exceptions that return clean error messages
  const hasStackTrace = /\s+at\s+[\w$.]+\([^)]+\)/.test(logText) || 
                        /\s+in\s+.+\.cs:line\s+\d+/i.test(logText) ||
                        /File\s+".+\.py",\s+line\s+\d+/.test(logText);
  
  // If it has a stack trace but no status code, it's likely an unhandled exception
  // Let it create an incident (safer default)
  if (hasStackTrace) {
    return false;
  }
  
  // No status code, no stack trace - might be a logged business error message
  // Check if it looks like a business error (has error keywords but structured)
  const businessErrorIndicators = [
    /\b(?:not found|already exists|invalid|required|forbidden|unauthorized)\b/i,
  ];
  
  // If it looks like a business error message (no stack trace), skip it
  if (businessErrorIndicators.some(pattern => pattern.test(logText))) {
    return true;
  }
  
  // Default: create incident (safer for unexpected log formats)
  return false;
}

function mapToIncidentDocument(record) {
  const logText = record.content || '';
  const serviceName = extractServiceFromLog(logText) || record['service.name'] || 'unknown';
  const errorSignature = extractErrorSignature(logText);
  
  return {
    // Sortable incident ID: timestamp + random (ensures uniqueness and sortability)
    incidentId:       `${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`,
    
    // Trace ID from application logs (for correlation)
    traceId:          record['dt.trace_id'] || record['trace_id'] || record['trace.id'] || null,
    
    // Service and error details
    serviceName:      serviceName,
    applicationName:  serviceName,  // Keep for backward compatibility
    hostName:         record['host.name'] || 'unknown',
    pid:              0,
    exceptionType:    errorSignature.split(':')[0] || 'UnhandledException',  // Extract from error signature
    exceptionMessage: extractErrorFromLog(logText) || logText.substring(0, 200),
    stackTrace:       logText,
    causedByChain:    [extractErrorFromLog(logText) || ''],
    
    // Context and metadata
    context: {
      source:         'dynatrace-log-poller',
      status:         record.status,
      timestamp:      record.timestamp,
      errorSignature: errorSignature,
      cloudProvider:  record['cloud.provider'] || 'unknown',
      cloudPlatform:  record['cloud.platform'] || 'unknown',
    },
    
    // Timestamps
    createdAt:        new Date(),  // When incident was first created
    occurredAt:       new Date(record.timestamp),  // When error occurred in app
    lastSeenAt:       new Date(record.timestamp),  // Will be updated on duplicates
    
    // Deduplication and tracking
    occurrenceCount:  0,  // Will be incremented by $inc (starts at 1)
    healingStatus:    'PENDING',
    incidentKey:      `${serviceName}:${errorSignature}`,  // Unique key for deduplication
    
    _class:           'com.dynatrace.log.LogEntry',
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

    // Filter out expected business exceptions (validation errors, not found, etc.)
    const incidentRecords = newRecords.filter(r => !isExpectedException(r.content || ''));
    logger.info(`Dynatrace log poller: ${incidentRecords.length} incident(s) after business exception filter (${newRecords.length - incidentRecords.length} expected exceptions skipped)`);

    if (incidentRecords.length === 0) {
      logger.info('Dynatrace log poller: no actionable incidents');
      // Still advance checkpoint even if no incidents created
      if (newRecords.length > 0) {
        const latest = new Date(newRecords[newRecords.length - 1].timestamp);
        latest.setMilliseconds(latest.getMilliseconds() + 1);
        await writeCheckpoint(latest.toISOString());
      }
      return;
    }

    const db  = await getDB();
    const col = db.collection(MONGO_COLLECTION);

    for (const record of incidentRecords) {
      const doc = mapToIncidentDocument(record);
      
      // Remove lastSeenAt from the document - it will be managed separately by $set
      const { lastSeenAt, occurrenceCount, ...insertDoc } = doc;
      
      // Deduplicate by incidentKey (service + error signature)
      // Only insert if this exact error doesn't already exist
      const result = await col.updateOne(
        { incidentKey: doc.incidentKey },
        { 
          $setOnInsert: insertDoc,
          $set: { lastSeenAt: new Date(record.timestamp) },
          $inc: { occurrenceCount: 1 }
        },
        { upsert: true }
      );
      
      if (result.upsertedCount > 0) {
        logger.info(`Dynatrace log poller: NEW incident created — ${doc.incidentKey}`);
      } else {
        logger.info(`Dynatrace log poller: DUPLICATE incident skipped — ${doc.incidentKey} (occurrence count incremented)`);
      }
    }

    logger.info(`Dynatrace log poller: processed ${incidentRecords.length} error log(s)`);

    // Advance checkpoint to latest record timestamp + 1ms (use newRecords, not incidentRecords)
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

async function ensureIndexes() {
  try {
    const db = await getDB();
    const col = db.collection(MONGO_COLLECTION);
    
    // Create unique index on incidentKey for deduplication
    await col.createIndex({ incidentKey: 1 }, { unique: true, background: true });
    
    // Create index on healingStatus for change stream filtering
    await col.createIndex({ healingStatus: 1 }, { background: true });
    
    // Create index on incidentId for sorting (descending = newest first)
    await col.createIndex({ incidentId: -1 }, { background: true });
    
    // Create index on createdAt for time-based queries
    await col.createIndex({ createdAt: -1 }, { background: true });
    
    // Create index on traceId for correlation queries
    await col.createIndex({ traceId: 1 }, { background: true, sparse: true });
    
    logger.info(`Dynatrace log poller: MongoDB indexes ensured`);
  } catch (err) {
    // Index might already exist - that's fine
    if (err.code !== 85 && err.code !== 86) {  // IndexOptionsConflict, IndexKeySpecsConflict
      logger.warn(`Dynatrace log poller: index creation warning — ${err.message}`);
    }
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
  Promise.all([ensureContainer(), ensureIndexes()])
    .then(() => {
      poll();
      setInterval(poll, POLL_INTERVAL_MS);
    })
    .catch(err => logger.error(`Dynatrace log poller failed to start: ${err.message}`));
}

module.exports = { start };
