require('dotenv').config();
const express = require('express');
const { connectDB } = require('./config/db');
const { startChangeStream } = require('./listener/changeStream');
const dynatraceWebhook = require('./webhook/dynatraceWebhook');
const logIngestWebhook = require('./webhook/logIngestWebhook');
const logger = require('./utils/logger');

async function main() {
  try {
    await connectDB();
    await startChangeStream();

    const app = express();
    app.use(express.json());
    app.use('/api/dynatrace', dynatraceWebhook);
    app.use('/api/logs', logIngestWebhook);

    app.get('/health', (_req, res) => res.json({ status: 'ok' }));

    const port = process.env.PORT || 3000;
    app.listen(port, () => logger.info(`HTTP server listening on port ${port}`));

    logger.info('incident-stream-processor is running...');
  } catch (err) {
    logger.error(`Failed to start: ${err.message}`);
    process.exit(1);
  }
}

main();
