const express = require('express');
const { requireInternalApiKey } = require('../middleware/internalApiKey');
const { updateIncidentStatus, parseObjectId } = require('../services/incidentStatusUpdate');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * PATCH /api/incidents/:mongoId/status
 * Optional manual/debug callback (primary Copilot path is POST /api/github/webhook).
 */
router.patch('/:mongoId/status', requireInternalApiKey, async (req, res) => {
  if (!parseObjectId(req.params.mongoId)) {
    return res.status(400).json({ error: 'Invalid MongoDB _id' });
  }

  try {
    const result = await updateIncidentStatus(req.params.mongoId, req.body || {});
    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    logger.error(`Status update failed for ${req.params.mongoId}: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
