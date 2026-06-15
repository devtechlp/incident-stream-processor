const crypto = require('crypto');
const express = require('express');
const logger = require('../utils/logger');
const { updateIncidentStatus, extractIncidentMongoId } = require('../services/incidentStatusUpdate');

const router = express.Router();

function verifyGitHubSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader || !rawBody) return false;

  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

function parseEscalationReason(commentBody) {
  const text = String(commentBody || '').trim();
  if (!text.toUpperCase().startsWith('ESCALATED:')) return null;
  return text.slice('ESCALATED:'.length).trim() || null;
}

async function handlePullRequestOpened(payload) {
  const pr = payload.pull_request;
  if (!pr) return { handled: false, reason: 'missing pull_request' };

  const mongoId = extractIncidentMongoId(pr.body);
  if (!mongoId) {
    return { handled: false, reason: 'PR body missing Incident MongoDB ID' };
  }

  const result = await updateIncidentStatus(mongoId, {
    healingStatus: 'PR_RAISED',
    prUrl: pr.html_url,
    prBranch: pr.head?.ref,
  });

  return { handled: true, mongoId, result };
}

async function handleIssueCommentCreated(payload) {
  const comment = payload.comment;
  const issue = payload.issue;
  if (!comment || !issue) return { handled: false, reason: 'missing comment or issue' };

  const escalationReason = parseEscalationReason(comment.body);
  if (!escalationReason) {
    return { handled: false, reason: 'comment does not start with ESCALATED:' };
  }

  const mongoId = extractIncidentMongoId(issue.body);
  if (!mongoId) {
    return { handled: false, reason: 'issue body missing Incident MongoDB ID' };
  }

  const result = await updateIncidentStatus(mongoId, {
    healingStatus: 'ESCALATED',
    escalationReason,
    issueUrl: issue.html_url,
  });

  return { handled: true, mongoId, result };
}

/**
 * POST /api/github/webhook
 * Mount with express.raw({ type: 'application/json' }) so HMAC verification works.
 */
router.post('/webhook', async (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('GitHub webhook: GITHUB_WEBHOOK_SECRET is not configured');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: 'Expected raw JSON body' });
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    logger.warn('GitHub webhook: rejected - invalid x-hub-signature-256');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const event = req.headers['x-github-event'];
  const action = payload.action;

  try {
    if (event === 'pull_request' && action === 'opened') {
      const outcome = await handlePullRequestOpened(payload);
      if (!outcome.handled) {
        logger.info(`GitHub webhook: ignored pull_request.opened - ${outcome.reason}`);
        return res.status(200).json({ status: 'ignored', reason: outcome.reason });
      }

      logger.info(
        `GitHub webhook: pull_request.opened incident=${outcome.mongoId} -> ${outcome.result.body.healingStatus ?? 'error'}`
      );
      return res.status(outcome.result.statusCode).json(outcome.result.body);
    }

    if (event === 'issue_comment' && action === 'created') {
      const outcome = await handleIssueCommentCreated(payload);
      if (!outcome.handled) {
        logger.info(`GitHub webhook: ignored issue_comment.created - ${outcome.reason}`);
        return res.status(200).json({ status: 'ignored', reason: outcome.reason });
      }

      logger.info(
        `GitHub webhook: issue_comment.created incident=${outcome.mongoId} -> ${outcome.result.body.healingStatus ?? 'error'}`
      );
      return res.status(outcome.result.statusCode).json(outcome.result.body);
    }

    logger.info(`GitHub webhook: ignored event=${event} action=${action}`);
    return res.status(200).json({ status: 'ignored', event, action });
  } catch (err) {
    logger.error(`GitHub webhook error: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
