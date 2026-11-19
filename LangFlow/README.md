# Incident Management Automation Prototype (Phase 1: Local)

A robust, production-grade incident-management prototype integrating:
`Four-Button Express App` &rarr; `PM2` &rarr; `PM2-Log-Viewer` &rarr; `LangFlow Webhook` &rarr; `Jira Cloud Bug Ticket`

---

## Architecture & Modular Directory Structure

```
LangFlow/
├── .env                         # Environment configuration (ignored in git)
├── .env.example                 # Example environment template
├── .gitignore                   # Git ignore for logs, state, secrets, dependencies
├── ecosystem.config.cjs         # PM2 ecosystem configuration
├── package.json                 # Project scripts and dependencies
├── pm2.js                       # Cross-platform PM2 workspace runner
├── app/                         # Four-button Express demo application
│   ├── server.js                # Backend with error generation & health endpoints
│   └── public/
│       ├── index.html           # 4-button UI
│       ├── style.css            # Responsive stylesheet
│       └── app.js               # Frontend button interactions
├── collector/                   # Disabled legacy direct collector
│   └── collector.js             # Opt-in migration tool; PM2-Log-Viewer is the source
├── langflow/                    # LangFlow docker compose, custom components & flows
│   ├── docker-compose.yml       # Docker Compose for LangFlow with .env injection & storage
│   ├── components/
│   │   └── jira_incident_component.py # Custom component (dedup, JQL search, Jira REST API v3)
│   └── flows/
│       └── incident_to_jira.json # Importable LangFlow flow definition
└── runtime/                     # Runtime logs and state (ignored in git)
    ├── pm2/
    │   ├── button-demo-error.log # PM2 structured error log
    │   └── button-demo-out.log   # PM2 stdout log
    └── collector-state.json     # Collector byte offset & processed incident state
```

---

## 1. Prerequisites

- **Node.js**: v18.0.0 or higher (v22 tested)
- **Docker Desktop**: Running with Linux containers
- **Atlassian Jira Cloud Account**: With project `DEMO` and issue type `Bug`

---

## 2. Installation

Clone or open the workspace and install root dependencies:

```powershell
npm install
```

---

## 3. Environment Variables Configuration

Ensure `.env` in the root directory contains the following variables:

```ini
# Jira Cloud Configuration
JIRA_BASE_URL=https://<your-instance>.atlassian.net
JIRA_EMAIL=<your-atlassian-email>
JIRA_API_TOKEN=<your-atlassian-api-token>
JIRA_PROJECT_KEY=DEMO
JIRA_ISSUE_TYPE=Bug

# LangFlow Configuration
LANGFLOW_BASE_URL=http://localhost:7860
LANGFLOW_PORT=7860
LANGFLOW_AUTO_LOGIN=true
LANGFLOW_API_KEY=<generated-langflow-api-key>
LANGFLOW_WEBHOOK_URL=http://localhost:7860/api/v1/webhook/incident_to_jira

# PM2-Log-Viewer integration (the viewer owns log ingestion and forwarding)
DIRECT_LOG_COLLECTOR_ENABLED=false
PM2_ERROR_LOG=runtime/pm2/button-demo-error.log
SERVICE_NAME=button-demo
ENVIRONMENT=local
STATE_FILE=runtime/collector-state.json
```

> [!NOTE]
> Format variables strictly as `KEY=VALUE` without whitespace before or after `=`.

---

## 4. How to Start the Prototype Services

### Step 1: Start LangFlow (Docker Compose)

From the project root:

```powershell
docker compose -f langflow/docker-compose.yml up -d
```

Verify LangFlow is healthy:
```powershell
curl http://localhost:7860/health
```

### Step 2: Start the Demo Application with PM2

```powershell
npm run pm2:start
```

Check PM2 status:
```powershell
node pm2.js list
```

### Step 3: Start PM2-Log-Viewer

In a separate terminal, start the independent viewer from its own project folder:
```powershell
cd ..\PM2-Log-Viewer
npm start
```

The viewer reads the PM2 log, normalizes incidents, displays them at
`http://localhost:3001`, and forwards them to the LangFlow webhook. Do not run
the legacy `npm run collector` command; it exits by default to prevent duplicate
Jira tickets.

Open the demo application UI in your browser at:
**[http://localhost:3000](http://localhost:3000)**

---

## 5. LangFlow Flow & Jira Configuration

The flow named `incident_to_jira` is exposed at:
`http://localhost:7860/api/v1/webhook/incident_to_jira`

### Structure
1. **Webhook Trigger**: Receives the normalized JSON event from PM2-Log-Viewer with `x-api-key` header authentication.
2. **Jira Incident Handler (`jira_incident_component.py`)**:
   - Computes deterministic SHA-256 fingerprint: `sha256(service|route|error_type|message)`.
   - Derives deduplication label: `incident-<prefix>` (first 8 characters).
   - Searches Jira Cloud with JQL: `labels = "incident-<prefix>"`.
   - **First Occurrence**: Creates a Jira Bug issue with formatted ADF description (What Failed, Metadata, Stack Trace, Likely Cause inference) and labels: `automated-incident`, `prototype`, `incident-<prefix>`.
   - **Duplicate Occurrence**: Adds a recurrence comment to the existing issue and updates the description evidence, incrementing the occurrence counter without creating uncontrolled duplicate tickets.

### Manual UI Flow Import (if required)
If you need to re-import the flow manually:
1. Open LangFlow at [http://localhost:7860](http://localhost:7860).
2. Click **My Collection** &rarr; **Import**.
3. Select `langflow/flows/incident_to_jira.json`.
4. Ensure the flow endpoint name is set to `incident_to_jira`.

---

## 6. Sample Webhook Payload & Curl Request

### Sample Payload
```json
{
  "service": "button-demo",
  "environment": "local",
  "route": "/api/fail-one",
  "error_type": "IntentionalPrototypeError",
  "message": "Test failure from button one",
  "stack_trace": "IntentionalPrototypeError: Test failure from button one\n    at ...",
  "request_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "timestamp": "2026-11-19T10:00:00.000Z",
  "log_reference": "runtime/pm2/button-demo-error.log",
  "fingerprint": "3c4792060fb8374fd8bbbcf58046561dd01a26f035dda5d1c3fb5bd17d768d29",
  "fingerprint_prefix": "3c479206"
}
```

### Direct Curl Request to LangFlow Webhook
```bash
curl -X POST http://localhost:7860/api/v1/webhook/incident_to_jira \
  -H "Content-Type: application/json" \
  -H "x-api-key: <YOUR_LANGFLOW_API_KEY>" \
  -d '{
    "service": "button-demo",
    "environment": "local",
    "route": "/api/fail-one",
    "error_type": "IntentionalPrototypeError",
    "message": "Test failure from button one",
    "request_id": "test-uuid-manual",
    "timestamp": "2026-11-19T10:00:00.000Z",
    "fingerprint": "3c4792060fb8374fd8bbbcf58046561dd01a26f035dda5d1c3fb5bd17d768d29",
    "fingerprint_prefix": "3c479206"
  }'
```

---

## 7. Local End-to-End Verification Procedure

1. **Verify Success Actions**:
   - Click **Success 1 (Turn Red)** &rarr; Page turns red, returns HTTP 200.
   - Click **Success 2 (Turn Blue)** &rarr; Page turns blue, returns HTTP 200.
2. **Trigger First Failure**:
   - Click **Fail Button 1** &rarr; Page background does not change, returns HTTP 500.
   - Inspect PM2 error log:
     ```powershell
     Get-Content runtime/pm2/button-demo-error.log -Tail 1
     ```
   - Observe PM2-Log-Viewer delivery status:
     ```
     [PM2-Log-Viewer] ... deliveryStatus=forwarded ...
     ```
   - Verify Jira Bug ticket creation with labels `automated-incident`, `prototype`, `incident-3c479206`.
3. **Trigger Duplicate Failure**:
   - Click **Fail Button 1** again.
   - Verify PM2-Log-Viewer emits the same fingerprint (`3c479206`).
   - Verify LangFlow updates the existing Jira ticket with a recurrence comment and updated occurrence count.
4. **Trigger Distinct Failure**:
   - Click **Fail Button 2**.
   - Verify new distinct fingerprint (`ccb50cd0`) and corresponding new incident ticket.

---

## 8. Stop and Restart Commands

| Action | Command |
|---|---|
| Stop PM2 app | `npm run pm2:stop` |
| Restart PM2 app | `npm run pm2:restart` |
| View PM2 logs | `npm run pm2:logs` |
| Stop LangFlow | `docker compose -f langflow/docker-compose.yml down` |
| Restart LangFlow | `docker compose -f langflow/docker-compose.yml restart` |

---

## 9. Troubleshooting

- **Jira Project Does Not Exist (`400 The target project doesn't exist`)**:
  Log into Jira Cloud at your `JIRA_BASE_URL` and create a project with key `DEMO` (e.g. Scrum or Kanban).
- **Atlassian API Auth Error (`401 Unauthorized`)**:
  Verify `JIRA_EMAIL` and `JIRA_API_TOKEN` in `.env`. Ensure there are no spaces around `=` on any line in `.env`.
- **EPERM / Permission error on PM2**:
  Use `npm run pm2:start` which sets `PM2_HOME` to `runtime/.pm2` within the workspace.
- **Collector cannot reach LangFlow**:
  Verify LangFlow container is up (`docker compose -f langflow/docker-compose.yml ps`) and `LANGFLOW_WEBHOOK_URL` points to `http://localhost:7860/api/v1/webhook/incident_to_jira`.

---

## 10. Jira Done to GitHub PR flow

The second flow is named `jira_done_to_pr` and listens at:

```text
POST /api/v1/webhook/jira_done_to_pr
```

For this prototype it is restricted to the configured demo repository and
base branch. When a Jira issue reaches `JIRA_PR_TRIGGER_STATUS` (`Done`), the
developer's branch must already exist as:

```text
fix/<JIRA-KEY>
```

The flow checks the branch, reuses an existing open PR when present, creates a
new PR when needed, comments the PR URL on Jira, and transitions the issue to
`JIRA_PR_RAISED_STATUS`. A missing branch is reported on Jira without creating
a PR.

Jira Cloud cannot call a local `localhost` endpoint directly. During local
testing, use a protected HTTPS tunnel and configure Jira to call the tunnel
URL. Keep the GitHub token only in `.env`; never put it in the flow canvas,
browser code, README, or repository history.
