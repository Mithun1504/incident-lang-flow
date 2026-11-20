# Incident Management Automation Prototype (Phase 1: Local)

A local teaching prototype integrating:
`Northstar Express Workspace` &rarr; `PM2` &rarr; `PM2-Log-Viewer` &rarr; `LangFlow Webhook` &rarr; `Jira Cloud Bug Ticket`

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
├── app/                         # Five-page Express demo workspace
│   ├── server.js                # Backend with error generation & health endpoints
│   └── public/
│       ├── index.html           # Business workspace UI
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

### Single Incident Lifecycle flow

One authenticated webhook routes application errors and Jira status events through
one graph. The intake lane normalizes and fingerprints an error, creates or
updates Jira, then returns the required developer branch. The resolution lane
checks the live Jira status and pushed commits, opens or reuses a PR, and links it
to Jira. The human development step happens between executions; the graph does
not hold a request open while someone fixes an issue.

The current replacement is staged as **Incident Lifecycle · Verification**.
The original production flows stay active until live verification and cutover.

```bash
# Update the isolated verification graph:
npm run flows:rebuild -- --staging
# After verification, update the existing production endpoint:
npm run flows:rebuild
# After restarting the watcher, remove the old PR graph and verification graph:
npm run flows:rebuild -- --retire-legacy
```

Original production graphs are backed up once under `runtime/flow-backups/`.
To roll back, restore those JSON definitions through LangFlow import/API and
restore the previous watcher version. Never retire the legacy graph while an old
watcher still targets it. Stop a foreground watcher with Ctrl+C, or use
`npm run pr:stop`; start the updated watcher with `npm run pr:start`.

Node outputs and native Traces show actual execution results. Incoming webhook
jobs run in the background; an open canvas does not promise continuous live
animation. The editor's default preview event safely takes the ignored branch.

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

The production **Incident Lifecycle** flow retains the compatible endpoint:
`http://localhost:7860/api/v1/webhook/incident_to_jira`

### Structure
1. **Webhook Trigger** receives the viewer event using `x-api-key`.
2. **Normalize Incident** unwraps Data/Message/string transport payloads, including literal newlines in stack traces. Missing route, error type, or message fails the run rather than creating a placeholder ticket.
3. **Fingerprint Incident** preserves the viewer fingerprint (16 hexadecimal characters) or computes SHA-256 when absent; the first eight characters form the Jira label.
4. **Create or Update Jira Ticket** searches active issues in the configured project by label, creates the configured issue type, or records recurrence on the existing active issue. Completed/Done-category issues are excluded, so an error after completion starts a new ticket. Titles are readable, for example `button-demo (local): IntentionalPrototypeError on /api/fail-two`. Telemetry and fingerprint remain in the description.

The unified graph uses `flow_*.py`; `lifecycle_api.py` is inlined into exported components. Compatibility repair/create commands delegate to the unified builder. Historical flow exports are retained for reference and rollback.

### Manual UI Flow Import (if required)
If you need to re-import the flow manually:
1. Open LangFlow at [http://localhost:7860](http://localhost:7860).
2. Click **My Collection** &rarr; **Import**.
3. Select `langflow/flows/incident_lifecycle.json` after publishing the unified graph.
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

1. Open the demo at `http://localhost:3000` and the viewer at `http://localhost:3001`.
2. Navigate Dashboard, My profile, Projects, Team, and Settings. Each page calls a corresponding `/api/*` endpoint. The viewer must show successful HTTP 200 requests with delivery **Not required**. No Jira tickets should be created for these requests.
3. Save a profile or notification preference to see PATCH/PUT request logs. Changes are stored in memory for the current demo session.
4. Click **Simulate service failure** in the workspace header. It calls `POST /api/simulate-failure`, returns HTTP 503, and emits one structured error to stderr.
5. Confirm the viewer displays the failure and forwards only that error to LangFlow. Confirm Jira creation separately; HTTP acceptance alone is not ticket confirmation.
6. Repeat the failure while its Jira ticket is active to verify recurrence on that ticket. After completion, a new failure creates a new ticket.

PM2 writes successful activity to `runtime/pm2/button-demo-out.log` and failures to `runtime/pm2/button-demo-error.log`. The viewer reads both independently. The original `/api/fail-one`, `/api/fail-two`, and success endpoints remain available for existing teaching exercises.

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

## 10. Resolved Jira incident to GitHub PR

The developer must implement and push the fix before resolving the ticket.
This automation opens a PR; it does not generate code, merge it, or deploy it.

For the current Jira Service Management `SUP` incident workflow, the **Resolve**
action moves the ticket to **Completed**. Configure:

```ini
JIRA_PR_TRIGGER_STATUS=Completed
JIRA_PR_RAISED_STATUS=
GITHUB_BRANCH_PREFIX=fix/
GITHUB_BASE_BRANCH=main
```

`JIRA_PR_RAISED_STATUS` is optional. Leave it empty when the project has no
`PR Raised` transition. The ticket then stays Completed and receives a PR link.
For another project, use its actual status name and issue type. `Done`,
`Resolved`, and `Completed` are different status names.

For a new incident such as SUP-4, work in the standalone developer repository:

```bash
git switch main
git pull --ff-only
git switch -c fix/SUP-4
# implement and verify the fix
git add server.js
git commit -m "Fix SUP-4"
git push -u origin fix/SUP-4
```

The prefix is configurable: setting `GITHUB_BRANCH_PREFIX=feature/` requires
`feature/SUP-4`. An existing remote branch with commits different from main is
required; creating an empty branch is not enough to open a PR.

After changing graph behavior or non-secret PR settings, deploy using:

```bash
npm run flows:rebuild
```

Trigger status, optional post-PR status, and branch prefix are copied into the
graph from `.env`. Credentials and repository settings remain server-side in
the LangFlow container; changing those requires Compose recreation.

### Local status watcher (recommended for this demo)

Run the poller under PM2 so resolving a ticket triggers the flow automatically:

```bash
npm run pr:start
# stop the watcher when done:
npm run pr:stop
```

`npm run pm2:start` starts both the embedded demo and this watcher. The watcher
searches only `automated-incident` issues in the configured project/status,
handles pagination, and does not overlap its polling cycles. Restart it after
changing `.env` or watcher code. The watcher is an event adapter, not a second LangFlow graph. It sends `event_type: jira.status_changed` to the same `LANGFLOW_WEBHOOK_URL` used by the log viewer. Do not run multiple pollers or both a webhook and a poller.

For one targeted verification, without leaving a watcher running:

```bash
node scripts/jira_pr_poller.cjs --once --issue=SUP-4
```

The resolution lane of **Incident Lifecycle** checks the live issue status, checks the configured
branch, reuses an open PR or creates one into main, and comments its URL on Jira.
Repeated successful invocations reuse the PR and avoid repeating the same PR
comment. Missing branches are blocked; authentication errors remain errors.
The poller confirms the Jira PR-link comment rather than treating webhook HTTP
acceptance as completion.

Alternatively configure Jira to POST to `/api/v1/webhook/incident_to_jira` through
a protected HTTPS tunnel. A browser GET is not a webhook test.

### Tests

```bash
npm test
```

The Python standard-library tests mock HTTP boundaries and cover transport
parsing, invalid events, titles, configured statuses/prefixes, branch failures,
live-status checks, PR reuse, and unavailable Jira transitions. They require no
LangFlow Python installation or credentials.

The embedded running demo and standalone developer repository are separate
copies. Pushing a fix does not change the embedded demo until you explicitly
deploy the updated application.

### Watcher execution control

The watcher checks GitHub for commits ahead of the base branch before sending a
resolved Jira event to LangFlow. Missing or empty fix branches stay in
`waiting_for_fix` locally and do not execute the graph. A newly pushed fix is
detected on a later poll. Unconfirmed executions retry with a 1 to 5 minute
backoff; changed Jira update timestamps or branch commit SHAs allow immediate
reprocessing. Existing PR-link comments continue to suppress completed work.
Restart the watcher after updating this script; no flow rebuild is needed.
