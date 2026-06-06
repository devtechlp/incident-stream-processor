const { getDB } = require('../config/db');
const logger = require('../utils/logger');
const { publishEvent } = require('../publisher');
const { formatAxiosError } = require('../publisher/httpPublisher');

let resumeToken = null;

// Deduplicates change events that MongoDB occasionally fires twice for the same
// oplog entry (e.g. during replica set elections or network retries).
// Keyed by the stringified resume token; capped at 200 entries.
const seenTokens = new Set();

function isDuplicate(changeId) {
  const key = JSON.stringify(changeId);
  if (seenTokens.has(key)) return true;
  seenTokens.add(key);
  if (seenTokens.size > 200) {
    seenTokens.delete(seenTokens.values().next().value);
  }
  return false;
}

async function startChangeStream() {
  const db = await getDB();
  const collection = db.collection(process.env.MONGO_COLLECTION);

  const pipeline = [
    { $match: { operationType: { $in: ['insert', 'update', 'replace'] } } }
  ];

  // Resume from last known position if we have one (survives container restarts)
  const options = { fullDocument: 'updateLookup' };
  if (resumeToken) {
    options.resumeAfter = resumeToken;
    logger.info('Resuming change stream from last token');
  }

  const changeStream = collection.watch(pipeline, options);
  logger.info(`Listening on: ${process.env.MONGO_COLLECTION}`);

  changeStream.on('change', async (change) => {
    // Persist resume token so a restart doesn't miss events
    resumeToken = change._id;

    if (isDuplicate(change._id)) return;

    logger.info(`Change detected: ${change.operationType} — id: ${change.documentKey?._id}`);

    const doc = change.fullDocument;
    if (!doc) {
      logger.warn('No fullDocument on change event — skipping');
      return;
    }

    // Skip if agent already picked this up — only forward PENDING documents
    if (doc.healingStatus && doc.healingStatus !== 'PENDING') {
      logger.info(`Skipping ${doc._id} — healingStatus already: ${doc.healingStatus}`);
      return;
    }

    try {
      await publishEvent(doc);
    } catch (err) {
      logger.error(`Failed to forward incident ${doc._id}: ${formatAxiosError(err)}`);
    }
  });

  changeStream.on('error', (err) => {
    logger.error(`Change stream error: ${err.message}`);
    // Reconnect after 5 seconds
    setTimeout(() => startChangeStream(), 5000);
  });

  changeStream.on('close', () => {
    logger.warn('Change stream closed — reconnecting in 5s');
    setTimeout(() => startChangeStream(), 5000);
  });
}

module.exports = { startChangeStream };
