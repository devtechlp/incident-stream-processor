require('dotenv').config();
const { connectDB } = require('./config/db');
const applicationLogPoller = require('./services/applicationLogPoller');
const logger = require('./utils/logger');

async function main() {
  try {
    await connectDB();
    applicationLogPoller.start();
    logger.info('Application log poller running locally — Ctrl+C to stop');
  } catch (err) {
    logger.error(`Failed to start poller: ${err.message}`);
    process.exit(1);
  }
}

main();
