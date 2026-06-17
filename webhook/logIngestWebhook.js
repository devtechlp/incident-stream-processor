const express = require('express');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');

const router = express.Router();

function extractErrorFromLog(logText) {
  const errorMatch = logText.match(/\berror=(.+)$/m);
  if (errorMatch) return errorMatch[1].trim();
  const msgMatch = logText.match(/\bmsg=(.+)$/m);
  if (msgMatch) return msgMatch[1].trim();
  const dotnetMsg = logText.match(/^(?:fail|crit):\s+[^\n]+\n[ \t]+([^\s\tat][^\n]+)/m);
  if (dotnetMsg) return dotnetMsg[1].trim();
  return null;
}

function mapToIncidentDocument(event) {
  const content       = event.content   || '';
  const exceptionText = event.exception || '';
  return {
    errorId:          Date.now() + Math.random(),
    traceId:          event['trace_id'] || event['dt.trace_id'] || '',
    spanId:           event['span_id']  || '',
    applicationName:  event['service.name'] || 'unknown',
    serviceName:      event['service.name'] || 'unknown',
    hostName:         event['host.name'] || event['cloud.platform'] || 'unknown',
    pid:              0,
    exceptionType:    'azure.log.ERROR',
    exceptionMessage: content,
    stackTrace:       exceptionText || content,
    causedByChain:    exceptionText ? [exceptionText.split('\n')[0]] : [content],
    context: {
      source:        'dynatrace-log-forwarder',
      logger:        event.logger        || '',
      thread:        event.thread        || '',
      cloudProvider: event['cloud.provider'] || '',
      cloudPlatform: event['cloud.platform'] || '',
      logSource:     event['log.source'] || '',
    },
    occurredAt:    new Date(event.timestamp),
    healingStatus: 'PENDING',
    _class:        'com.azure.log.LogEntry',
  };
}

// Legacy direct ingest — not used when Dynatrace poller path is active.
// Accepts the same array payload dynatrace-log-forwarder sends to Dynatrace.
router.post('/ingest', async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];

  if (events.length === 0) {
    return res.status(400).json({ error: 'No events provided' });
  }

  try {
    const db = await getDB();
    const col = db.collection(process.env.MONGO_COLLECTION);

    for (const event of events) {
      const doc = mapToIncidentDocument(event);
      await col.updateOne(
        { applicationName: doc.applicationName, occurredAt: doc.occurredAt },
        { $setOnInsert: doc },
        { upsert: true }
      );
    }

    logger.info(`Log ingest: accepted ${events.length} event(s)`);
    return res.status(201).json({ status: 'accepted', processed: events.length });
  } catch (err) {
    logger.error(`Log ingest error: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
