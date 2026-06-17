const { getDB } = require('../config/db');
const logger = require('../utils/logger');

/**
 * Atomically mark an incident as dispatched so only one agent receives it,
 * even when the change stream fires twice (insert + update, duplicate replicas, etc.).
 */
async function claimIncidentForDispatch(doc, targetUrl) {
  const col = (await getDB()).collection(process.env.MONGO_COLLECTION);

  const result = await col.updateOne(
    {
      _id: doc._id,
      dispatchedAt: { $exists: false },
      $or: [{ healingStatus: { $exists: false } }, { healingStatus: 'PENDING' }],
    },
    {
      $set: {
        dispatchedAt: new Date(),
        dispatchedTo: targetUrl,
      },
    }
  );

  return result.modifiedCount === 1;
}

async function releaseDispatchClaim(doc, targetUrl) {
  const col = (await getDB()).collection(process.env.MONGO_COLLECTION);

  await col.updateOne(
    { _id: doc._id, dispatchedTo: targetUrl },
    { $unset: { dispatchedAt: '', dispatchedTo: '' } }
  );

  logger.warn(`Released dispatch claim for incident ${doc._id} after forward failure`);
}

module.exports = { claimIncidentForDispatch, releaseDispatchClaim };
