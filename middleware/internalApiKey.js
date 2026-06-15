/**
 * Validates x-api-key header against INTERNAL_API_KEY.
 * Used for optional manual PATCH /api/incidents/:id/status (debug).
 */

function requireInternalApiKey(req, res, next) {
  const expected = process.env.INTERNAL_API_KEY;

  if (!expected) {
    return res.status(503).json({ error: 'INTERNAL_API_KEY is not configured' });
  }

  const provided = req.headers['x-api-key'];
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

module.exports = { requireInternalApiKey };
