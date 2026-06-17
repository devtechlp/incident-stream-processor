/**
 * Resolve service name consistently for routing and logging.
 * Incidents may use serviceName (poller) or applicationName (legacy webhooks).
 */
function resolveServiceName(doc) {
  return (
    doc?.serviceName
    || doc?.applicationName
    || doc?.service?.name
    || doc?.service_name
    || 'unknown'
  );
}

module.exports = { resolveServiceName };
