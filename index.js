require('dotenv').config();
const { connectDB } = require('./config/db');
const { startChangeStream } = require('./listener/changeStream');
const logger = require('./utils/logger');

async function main() {
  try {
    await connectDB();
    await startChangeStream();
    logger.info('incident-stream-processor is running...');
  } catch (err) {
    logger.error(`Failed to start: ${err.message}`);
    process.exit(1);
  }
}

main();
