const { getDB } = require('../config/db');
const { createIncidentIssue, assertJiraConfigured } = require('../services/jiraClient');
const { mapIncidentToJiraFields } = require('./jiraIncidentMapper');
const { claimIncidentForDispatch, releaseDispatchClaim } = require('./dispatchClaim');
const logger = require('../utils/logger');

/** Stored on Mongo dispatchedTo — agent is triggered by JSM Automation, not stream-processor. */
const JIRA_AUTOMATION_DISPATCH_TARGET = 'jira://jsm-automation';

async function recordJiraIssue(incidentId, issueKey) {
  const col = (await getDB()).collection(process.env.MONGO_COLLECTION);
  await col.updateOne(
    { _id: incidentId },
    {
      $set: {
        jiraIssueKey: issueKey,
        healingStatus: 'JIRA_CREATED',
      },
    }
  );
}

/**
 * Creates a JSM customer request for the incident. Remediation is started by the
 * JSM Automation rule (Report an Issue → agent) — same path as manual portal reports.
 */
async function publishToJira(doc, config) {
  assertJiraConfigured();

  const { source, jiraServiceName } = config;
  const targetUrl = JIRA_AUTOMATION_DISPATCH_TARGET;

  const claimed = await claimIncidentForDispatch(doc, targetUrl);
  if (!claimed) {
    logger.info(
      `Skipping incident ${doc._id} (${config.serviceName}) — already dispatched or no longer PENDING`
    );
    return { skipped: true, reason: 'already_dispatched' };
  }

  logger.info(
    `Routing incident ${doc._id} (${config.serviceName}) via ${source} → Jira (JSM Automation will trigger agent)`
  );

  try {
    const fields = mapIncidentToJiraFields(doc, { jiraServiceName });
    if (!fields.serviceName) {
      throw new Error(
        `Could not map Dynatrace service to Jira Service Name for incident ${doc._id}. ` +
          'Set jiraServiceName on the routing rule or use a known service name.'
      );
    }

    let issueKey = doc.jiraIssueKey;
    if (!issueKey) {
      issueKey = await createIncidentIssue(fields);
      await recordJiraIssue(doc._id, issueKey);
    } else {
      logger.info(`Reusing existing Jira issue ${issueKey} for incident ${doc._id}`);
    }

    logger.info(
      `Incident ${doc._id} created in Jira as ${issueKey} — awaiting JSM Automation rule to trigger agent`
    );
    return { skipped: false, jiraIssueKey: issueKey };
  } catch (err) {
    await releaseDispatchClaim(doc, targetUrl);
    throw err;
  }
}

module.exports = { publishToJira, recordJiraIssue, JIRA_AUTOMATION_DISPATCH_TARGET };
