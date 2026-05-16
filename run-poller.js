require('dotenv').config();
const { connectDB } = require('./config/db');
const dynatraceLogPoller = require('./services/dynatraceLogPoller');
const logger = require('./utils/logger');

async function main() {
  try {
    await connectDB();
    dynatraceLogPoller.start();
    logger.info('Dynatrace log poller running locally — Ctrl+C to stop');
  } catch (err) {
    logger.error(`Failed to start poller: ${err.message}`);
    process.exit(1);
  }
}

main();
