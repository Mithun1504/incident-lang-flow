# PM2 Log Viewer

A light-theme request activity dashboard. It reads PM2 stdout and stderr, displays successful requests, warnings, and failures in one live table, and forwards only error-level events to LangFlow.

## Run

```bash
npm ci
npm start
```

Open http://localhost:3001. `npm run dev` starts with Node's file watcher.

After a backend change, stop the viewer with Ctrl+C and start it again. Restart the demo application after changing its server code. Static frontend changes need only a browser reload.

## Configuration

Copy `.env.example` to `.env` for a new setup. Paths resolve relative to this viewer's directory.

| Variable | Purpose |
|---|---|
| `PM2_LOG_SOURCE` | PM2 stderr file, including structured application errors |
| `PM2_OUT_LOG_SOURCE` | PM2 stdout file, including successful requests; when omitted, derived from the error filename by replacing `error.log` with `out.log` |
| `LOG_STATE_FILE` | Persistent stderr read offset and forwarded IDs |
| `OUT_LOG_STATE_FILE` | Independent stdout read offset |
| `OUTBOX_FILE` | Persistent failed-error delivery queue |
| `PORT` | Viewer port, default 3001 |
| `LANGFLOW_WEBHOOK_URL` | Incident webhook endpoint |
| `LANGFLOW_API_KEY` | Server-side `x-api-key` credential |
| `FORWARD_ENABLED` | `true` forwards errors; `false` records dry-run delivery |
| `POLL_INTERVAL_MS` | File polling interval, default 1000 |
| `MAX_RETRIES` | Immediate delivery attempts, default 3 |
| `RETRY_DELAY_MS` | Initial retry delay, default 1000 |

The existing setup reads `../LangFlow/runtime/pm2/button-demo-error.log` and `../LangFlow/runtime/pm2/button-demo-out.log`. When using another demo copy, point both source variables at that application's files.

There is no need to reset or delete existing log state. Each stream has its own state file. Historical lines appear without being automatically forwarded on first startup. Event IDs are stable for structured entries with request IDs and timestamps, allowing delivery history to survive a restart.

## Dashboard

The default view shows all activity, newest first, capped at 500 entries. Filter by successful requests, errors, warnings, text, and delivery status. Expand a row for its message, correlation ID, metadata, and stack trace. Error rows offer manual delivery retry. Successful requests show **Not required** and cannot be sent to Jira through the API, UI, or forwarder.

**Accepted** means LangFlow accepted the webhook, not that Jira finished creating a ticket. Confirm ticket completion in Jira or the LangFlow execution results. This redesign leaves the downstream LangFlow/Jira/PR logic unchanged.

SSE pushes new requests and delivery updates. The browser falls back to polling while reconnecting. Search and filters continue to apply to live events.

## APIs

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Counts, source availability, offsets, forwarding mode, pending queue |
| GET | `/api/logs?limit=500` | All recent structured log levels |
| GET | `/api/incidents` | Error events only, for integrations |
| GET | `/api/logs/:eventId` | Single log by event/request ID |
| GET | `/api/events/stream` | Live log and delivery events |
| POST | `/api/retry/:eventId` | Retry an error; returns 400 for non-error activity |
| POST | `/api/retry-all` | Retry eligible queued errors |
| POST | `/api/toggle-forward` | Toggle forwarding for this process |

## Verify

```bash
npm run lint
npm test
```

Tests cover normalization, both log levels, tailing, truncation, forwarding, and API protection. When the sibling `LangFlow/app` is present, an integration test runs five real page APIs through physical stdout/stderr files and an independent viewer process, verifying that only the HTTP 503 failure reaches a mock webhook. Tests do not create Jira tickets.

Do not run the disabled legacy collector alongside this viewer. Keep credentials out of browser code, runtime responses, and Git.
