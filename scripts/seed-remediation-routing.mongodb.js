// Seed remediation_routing — works in mongosh CLI and MongoDB Compass (no cat/fs required).
//
// BEFORE RUNNING: replace the placeholder keys below with real Azure Function host keys,
// or copy scripts/remediation-routing.local.json (gitignored) and paste its values here.
//
// mongosh CLI:
//   mongosh "<MONGO_URI>" --file scripts/seed-remediation-routing.mongodb.js
//
// MongoDB Compass: open Mongosh tab, paste this entire file and run.

const dbName = "incident_management";

const routing = {
  _id: "routing",
  defaultFunctionAppUrl:
    "https://incident-remediation-agent-fn.azurewebsites.net/api/processIncident",
  defaultFunctionAppKey: "<incident-remediation-agent-fn host key>",
  rules: [
    {
      serviceName: "freight-planning-invoice-service",
      functionAppUrl:
        "https://incident-remediation-agent-foundry-fn.azurewebsites.net/api/processIncident",
      functionAppKey: "<incident-remediation-agent-foundry-fn host key>",
    },
  ],
};

db = db.getSiblingDB(dbName);

const result = db.remediation_routing.replaceOne(
  { _id: routing._id },
  routing,
  { upsert: true }
);

print("Database: " + dbName);
print("Collection: remediation_routing");
print(
  "Matched: " +
    result.matchedCount +
    ", Modified: " +
    result.modifiedCount +
    ", Upserted: " +
    (result.upsertedId ? result.upsertedId : "none")
);
printjson(db.remediation_routing.findOne({ _id: "routing" }));
