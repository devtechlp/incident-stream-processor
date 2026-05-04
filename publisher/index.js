const { publish } = require('./httpPublisher');
const logger = require('../utils/logger');

async function publishEvent(doc) {
  logger.info(`Forwarding incident ${doc._id} to agent Function App`);
  await publish(doc);
}

module.exports = { publishEvent };
