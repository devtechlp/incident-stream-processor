require('dotenv').config();
const express = require('express');
const { connectDB } = require('./config/db');
const { startChangeStream } = require('./listener/changeStream');
const dynatraceWebhook = require('./webhook/dynatraceWebhook');
const logIngestWebhook = require('./webhook/logIngestWebhook');
const githubWebhook = require('./webhook/githubWebhook');
const incidentStatus = require('./api/incidentStatus');
const dynatraceLogPoller = require('./services/dynatraceLogPoller');
const logger = require('./utils/logger');

async function main() {
  try {
    await connectDB();
    await startChangeStream();
    dynatraceLogPoller.start();

    const app = express();

    // GitHub org webhook requires raw body for HMAC verification (before express.json())
    app.use('/api/github', express.raw({ type: 'application/json' }), githubWebhook);

    app.use(express.json());
    app.use('/api/dynatrace', dynatraceWebhook);
    app.use('/api/logs', logIngestWebhook);
    app.use('/api/incidents', incidentStatus);

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
