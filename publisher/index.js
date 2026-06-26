const { publish } = require('./httpPublisher');
const { publishToJira } = require('./jiraPublisher');
const { resolveDispatchConfig } = require('./agentRouter');
const logger = require('../utils/logger');

async function publishEvent(doc) {
  const config = await resolveDispatchConfig(doc);

  if (config.destination === 'jira') {
    logger.info(`Forwarding incident ${doc._id} to Jira remediation path`);
    await publishToJira(doc, config);
    return;
  }

  logger.info(`Forwarding incident ${doc._id} to agent Function App`);
  await publish(doc, config);
}

module.exports = { publishEvent };
