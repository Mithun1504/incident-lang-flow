# PM2 Log Viewer & Incident Forwarder

An independent Node.js log-monitoring dashboard and webhook forwarder running on port `3001`. It incrementally tails PM2 JSON error logs, normalizes them into structured incident events, visualizes them in real time with Server-Sent Events (SSE), and forwards new error incidents to the LangFlow webhook to trigger Jira ticket automation.

---

## Architecture Flow

```
+------------------------------------+
|  PM2 Application (e.g. port 3000)  |
|  Writes JSON error entries to:     |
|  runtime/pm2/button-demo-error.log |
+------------------+-----------------+
                   |
                   v (Incremental byte offset tailing)
+------------------+-----------------+
|   PM2-Log-Viewer (Port 3001)       |
|  - Real-time Web UI Dashboard      |
|  - Tracks offset in state file     |
|  - Normalizes stack & fingerprints |
|  - Exponential backoff & outbox    |
+------------------+-----------------+
                   |
                   v (POST /api/v1/webhook/incident_to_jira + x-api-key)
+------------------+-----------------+
|      LangFlow (Port 7860)          |
|  - Validates payload               |
|  - Custom Jira Component           |
+------------------+-----------------+
                   |
                   v (Atlassian REST API)
+------------------+-----------------+
|         Jira Cloud (DEMO)          |
|  - Creates or deduplicates Bug     |
+------------------------------------+
```

---

## Folder Structure

```
PM2-Log-Viewer/
├── .env.example              # Sample environment configuration template
├── .env                      # Local configuration (API keys, ports, paths)
├── .gitignore                # Git ignore rules (node_modules, runtime states)
├── package.json              # Project metadata, dependencies, and npm scripts
├── README.md                 # Project documentation
├── public/                   # Frontend assets served at http://localhost:3001
│   ├── index.html            # Dashboard layout and metric cards
│   ├── style.css             # Modern dark slate styling & responsive layout
│   └── app.js                # SSE client, search/filter, and retry actions
├── runtime/                  # Dynamic runtime state & retry persistence
│   ├── log-viewer-state.json # Persistent byte offset & processed fingerprints
│   └── outbox.json           # Outbox queue for temporary webhook failures
├── scripts/
│   └── lint.js               # JavaScript syntax and integrity linter
├── src/
│   ├── config.js             # Configuration loader & path resolution logic
│   ├── normalizer.js         # Stack trace cleaner, path normalizer & SHA-256 fingerprinting
│   ├── logReader.js          # Incremental byte offset reader with rotation handling
│   ├── forwarder.js          # Webhook dispatcher with exponential backoff & outbox
│   ├── outbox.js             # Outbox persistence and retry scheduler
│   └── server.js             # Express API server, SSE stream & static server
└── test/
    ├── normalizer.test.js    # Unit tests for incident normalization & fingerprints
    ├── logReader.test.js     # Incremental reading & truncation tests
    ├── forwarder.test.js     # Dry-run, retry, and HTTP 202 acceptance tests
    └── api.test.js           # REST API endpoint tests & security assertions
```

---

## Configuration (`.env`)

Configuration is loaded exclusively from `PM2-Log-Viewer/.env`:

```ini
# Path to the PM2 error log (resolved relative to PM2-Log-Viewer root)
PM2_LOG_SOURCE=../LangFlow/runtime/pm2/button-demo-error.log

# Port for the PM2-Log-Viewer web server & dashboard
PORT=3001

# LangFlow Incident Webhook Endpoint
LANGFLOW_WEBHOOK_URL=http://localhost:7860/api/v1/webhook/incident_to_jira

# LangFlow API Key (sent in x-api-key header)
LANGFLOW_API_KEY=<your-langflow-api-key>

# Persistent state file for byte offset tracking
LOG_STATE_FILE=runtime/log-viewer-state.json

# Local retry outbox for failed deliveries
OUTBOX_FILE=runtime/outbox.json

# Forwarding switch: true to forward to LangFlow, false for Dry-Run mode
FORWARD_ENABLED=true
```

### How `PM2_LOG_SOURCE` is Resolved

`PM2_LOG_SOURCE` is resolved **strictly relative to the `PM2-Log-Viewer` application directory**, rather than the process working directory (`process.cwd()`):

```javascript
const appRootDir = path.resolve(__dirname, '..');
const logSourcePath = path.isAbsolute(process.env.PM2_LOG_SOURCE)
  ? process.env.PM2_LOG_SOURCE
  : path.resolve(appRootDir, process.env.PM2_LOG_SOURCE);
```

This guarantees that whether you start the application from `C:/`, `C:/Users/USER/Desktop/Ellipsonic-Projects`, or `C:/Users/USER/Desktop/Ellipsonic-Projects/PM2-Log-Viewer`, it will reliably locate `../LangFlow/runtime/pm2/button-demo-error.log`.

---

## Important Testing Precaution

> [!IMPORTANT]
> **Stop the legacy PM2 collector before testing to avoid duplicate tickets!**
> If the older background collector script in `LangFlow/` is running concurrently, both applications will detect new error log entries and both will submit events to LangFlow.
> Ensure only `PM2-Log-Viewer` is running to tail the log.

---

## Dry-Run Mode (Testing without Creating Jira Tickets)

To monitor and test the UI and log reader without sending events to LangFlow or creating Jira tickets:

1. **Option A (Via `.env`)**:
   Set `FORWARD_ENABLED=false` in `.env`.
   When a new error arrives, the UI will display it with status `DRY-RUN`, and no HTTP requests will be made.

2. **Option B (Via UI)**:
   In the header of `http://localhost:3001`, click the **Mode: Forwarding: ON** badge. It will toggle to **Dry-Run: ON** on the fly without restarting the server.

---

## Getting Started

### 1. Install Dependencies
```bash
cd C:/Users/USER/Desktop/Ellipsonic-Projects/PM2-Log-Viewer
npm install
```

### 2. Run Lint & Automated Tests
```bash
npm run lint
npm test
```

### 3. Start the Application
- **Production mode**:
  ```bash
  npm start
  ```
- **Development mode (auto-reload on code change)**:
  ```bash
  npm run dev
  ```

Open your browser at **[http://localhost:3001](http://localhost:3001)**.

---

## API Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Service status, port, uptime, log source existence, byte offset, outbox count (zero API key leakage). |
| `/api/logs` | `GET` | Normalized incident entries (newest first). Supports `?limit=N`. |
| `/api/incidents` | `GET` | Normalized incidents owned by this application for integrations and audits. Supports `?limit=N`. |
| `/api/logs/:eventId` | `GET` | Detailed JSON for a specific incident by `event_id` or `request_id`. |
| `/api/events/stream` | `GET` | Server-Sent Events (SSE) stream for real-time live push of new errors and delivery status updates. |
| `/api/retry/:eventId` | `POST` | Manually triggers redelivery of an incident to the LangFlow webhook. |
| `/api/retry-all` | `POST` | Drains all pending items from the local outbox. |
| `/api/toggle-forward` | `POST` | Toggles forwarding between active and dry-run mode. |

---

## Key Design Details

1. **Incremental Reading & State Persistence**:
   - The exact byte offset is persisted in `runtime/log-viewer-state.json`.
   - On server restart, the app inspects the state file and does **not** re-send already processed logs.
   - If the log file size shrinks below `lastByteOffset`, log truncation/rotation is detected, and the offset safely resets to 0.

2. **Stack Trace & Path Normalization**:
   - Strips ANSI terminal color escape codes.
   - Normalizes Windows backslashes in paths (`C:\...` -> `C:/...`) so payloads format cleanly across operating systems.

3. **Exponential Backoff & Outbox**:
   - Webhook deliveries are attempted with exponential backoff (`2^attempt * retryDelayMs`).
   - Responses with HTTP 200, 201, or 202 are treated as successful.
   - If retries fail, incidents are placed in `runtime/outbox.json` and a periodic background worker retries them automatically.

4. **Safety & Zero Disruption**:
   - The existing `LangFlow/` project, `.env`, Docker containers, and port 3000 server are strictly unmodified.
   - API keys and tokens are never exposed in UI responses or logs.
