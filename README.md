# incident-lang-flow

A local incident-automation prototype containing three independent applications:

- `LangFlow/` — LangFlow flows and custom components. It receives normalized incidents, creates/deduplicates Jira tickets, and can create a GitHub PR from `fix/<JIRA-KEY>` after a ticket reaches its configured resolved status.
- `incident-demo-app/` — the five-page Northstar business workspace with successful API activity and a header failure action.
- `PM2-Log-Viewer/` — a small log-viewer/forwarder application that reads the demo PM2 stdout and stderr logs and forwards normalized incidents to LangFlow.

## Local topology

```text
incident-demo-app (port 3000)
        |
        v
   PM2 stdout + stderr
        |
        v
PM2-Log-Viewer (port 3001) ---> LangFlow (port 7860) ---> Jira
                                                       |
                         developer pushes fix/DEMO-XX |
                                                       v
                                                   GitHub PR
```

## Configuration

Each application has its own `.env.example`. Copy it to `.env` locally and fill in credentials; never commit `.env` files or runtime state.

The LangFlow application uses Docker Compose. The demo and viewer use Node.js/PM2. See each application README for commands and troubleshooting.

## Security

Tokens are intentionally excluded from this repository. If a credential is ever committed, revoke it and replace it immediately.
