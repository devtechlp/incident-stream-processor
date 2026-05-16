# incident-stream-processor

Node.js worker that watches a MongoDB collection with a **change stream**, then **POST**s each new or updated document to the **incident-agent** Azure Function (`processIncident` HTTP trigger). It sits between your services that write error logs to Mongo and the agent that triages them.

## Flow

1. A service (for example offer-intake or an exception demo API) inserts or updates a document in the configured collection.
2. This process receives the change event (`insert`, `update`, or `replace`).
3. If `healingStatus` is missing or **`PENDING`**, the full document is forwarded to `FUNCTION_APP_URL` with `x-functions-key`.
4. Documents already marked non-pending (`healingStatus !== 'PENDING'`) are skipped so the agent is not called twice.

## Requirements

- **Node.js** 18+ locally (the container image uses Node 22).
- **MongoDB** with change streams enabled (typically a **replica set**, including MongoDB Atlas).
- **Azure Function App** URL and host key for the incident-agent `processIncident` endpoint.

## Configuration

Copy `.env.example` to `.env` and set values to match your environment. The collection name must be the same one your writers use (often `service_error_logs` in this incident stack).

| Variable | Description |
|----------|-------------|
| `MONGO_URI` | MongoDB connection string (SRV or standard). |
| `MONGO_DB_NAME` | Database name (for example `incident_management`). |
| `MONGO_COLLECTION` | Collection to watch (for example `service_error_logs`). |
| `FUNCTION_APP_URL` | Full HTTPS URL of the Function HTTP trigger (for example `https://<app>.azurewebsites.net/api/processIncident`). |
| `FUNCTION_APP_KEY` | Azure Function **host** key (portal: Function App → **App keys**). Sent as header `x-functions-key`. |
| `LOG_LEVEL` | Optional Winston level (default `info`). |

## Run locally

```bash
cd incident-stream-processor
npm install
cp .env.example .env   # then edit .env
npm start
```

Logs go to the console.

## Run with Docker

```bash
docker build -t incident-stream-processor .
docker run --rm -e MONGO_URI="..." -e MONGO_DB_NAME="..." -e MONGO_COLLECTION="..." -e FUNCTION_APP_URL="..." -e FUNCTION_APP_KEY="..." incident-stream-processor
```

## Deploy (Azure Container Apps)

GitHub Actions workflow: `.github/workflows/deploy-azure-containerapp.yml`.

It builds the image in ACR and runs a **single-replica** Container App (no HTTP ingress): a background worker.

Repository secrets expected by the workflow (in addition to your usual Azure ACR / Container Apps secrets):

| Secret | Used for |
|--------|----------|
| `MONGO_URI` | Mongo connection |
| `MONGO_DB_NAME` | Database name |
| `MONGO_COLLECTION` | Watched collection |
| `FUNCTION_APP_URL` | Agent Function trigger URL |
| `FUNCTION_APP_KEY` | Function host key |

Same names as environment variables above.

## Project layout

| Path | Role |
|------|------|
| `index.js` | Entry: connect Mongo, start change stream. |
| `config/db.js` | `MongoClient` connection and `getDB()`. |
| `listener/changeStream.js` | Watches the collection, filters by `healingStatus`, calls publisher. |
| `publisher/httpPublisher.js` | `axios` POST to the Function with JSON body and key header. |
| `utils/logger.js` | Winston console logger. |

## Behavior notes

- The change stream uses **`fullDocument: 'updateLookup'`** so updates include the latest document body when MongoDB provides it.
- On **change stream error or close**, the listener schedules a **reconnect after 5 seconds** (in-process).
- Only documents whose **`healingStatus` is unset or `PENDING`** are forwarded; others are logged and skipped.
- HTTP timeout to the Function is **15 seconds**; successful responses are logged with status code.

## Troubleshooting

- **No events**: Confirm replica set / Atlas tier supports change streams, and that inserts hit `MONGO_DB_NAME` + `MONGO_COLLECTION`.
- **401 / 403 from Function**: Check `FUNCTION_APP_URL` (correct function and route) and `FUNCTION_APP_KEY` (host key, not a client secret unless your function is configured for that).
- **Connection errors**: Verify `MONGO_URI` from the same network context as the processor (VPC / firewall / Atlas IP allowlist).

## Full pipeline documentation

End-to-end flow (this worker plus **incident-agent**), naming, and `healingStatus` lifecycle: if you keep both repos as siblings under the same parent folder, see **`../incident-agent/docs/INCIDENT_REMEDIATION_PIPELINE.md`**. Otherwise open that path in the **incident-agent** repository.
