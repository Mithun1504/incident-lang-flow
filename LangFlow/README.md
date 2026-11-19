# Incident Management Automation Prototype (Phase 1: Local)

A local teaching prototype integrating:
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

### Visual LangFlow pipelines

The saved flows are intentionally multi-node graphs:

```text
incident_to_jira:
PM2-Log-Viewer Webhook → Normalize Incident → Fingerprint Incident → Create or Update Jira Ticket

jira_done_to_pr:
Jira Webhook → Parse Jira Event → Check Jira Status → Prepare PR Context → Create GitHub PR
```

To rebuild the visual graphs after changing a component:

```powershell
npm run flows:rebuild
```

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
1. **Webhook Trigger** receives the viewer event using `x-api-key`.
2. **Normalize Incident** unwraps Data/Message/string transport payloads, including literal newlines in stack traces. Missing route, error type, or message fails the run rather than creating a placeholder ticket.
3. **Fingerprint Incident** preserves the viewer fingerprint (16 hexadecimal characters) or computes SHA-256 when absent; the first eight characters form the Jira label.
4. **Create or Update Jira Ticket** searches the configured project by label, creates the configured issue type, or records recurrence on the existing issue. Titles are readable, for example `button-demo (local): IntentionalPrototypeError on /api/fail-two`. Telemetry and fingerprint remain in the description.

The current graphs use `flow_*.py`. The older all-in-one components and repair/create scripts are legacy and should not be used to deploy the multi-node graphs.

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
changing `.env`. Do not run multiple pollers or both a webhook and a poller.

For one targeted verification, without leaving a watcher running:

```bash
node scripts/jira_pr_poller.cjs --once --issue=SUP-4
```

The `jira_done_to_pr` flow checks the live issue status, checks the configured
branch, reuses an open PR or creates one into main, and comments its URL on Jira.
Repeated successful invocations reuse the PR and avoid repeating the same PR
comment. Missing branches are blocked; authentication errors remain errors.
The poller confirms the Jira PR-link comment rather than treating webhook HTTP
acceptance as completion.

Alternatively configure Jira to POST to `/api/v1/webhook/jira_done_to_pr` through
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
