# Northstar demo workspace

A small business workspace for demonstrating request logging and incident automation. The UI uses plain HTML, CSS, and JavaScript with an Express API. Sample data is fictional and stored in memory.

## Run

```bash
npm ci
npm start
```

Open http://localhost:3000. For the incident pipeline, run through PM2 so stdout and stderr are captured:

```bash
npm run pm2:start
```

Run only one demo copy on port 3000. The aggregate repository also contains the same application under `LangFlow/app/` and `incident-demo-app/`. Its existing PM2 configuration runs the embedded `LangFlow/app/` copy. Pushing a branch to GitHub does not deploy it to another running copy.

## Pages and APIs

| Page | API | Result |
|---|---|---|
| Dashboard | `GET /api/dashboard` | Workspace metrics, projects, upcoming work, activity |
| My profile | `GET /api/my-profile` | Fictional user profile |
| Projects | `GET /api/projects` | Searchable project list |
| Team | `GET /api/team` | Searchable team directory |
| Settings | `GET /api/settings` | Workspace details and notification preferences |
| Save profile | `PATCH /api/my-profile` | Session-only profile updates |
| Save preferences | `PUT /api/settings` | Session-only notification updates |
| Header failure action | `POST /api/simulate-failure` | Intentional HTTP 503 and one structured error |

Page navigation calls its API, including browser back/forward and direct page links. Profile and preference changes reset when the server restarts.

Every `/api/*` request writes one structured completion log with level, route, method, HTTP status, duration, request ID, and timestamp. Successful requests and client warnings go to stdout; HTTP 5xx errors go to stderr. The log viewer displays both streams, but only error-level events trigger Jira. The original success/failure endpoints remain for existing teaching branches.

## Fix-branch workflow

In this standalone developer repository, create `fix/<JIRA-KEY>`, implement and test the application fix, then commit and push it. Resolve the matching Jira ticket only after the branch exists remotely with a real change from main. The separate Jira watcher triggers LangFlow to open the PR.

```bash
git switch -c fix/SUP-123
# implement and test the fix
npm test
git add server.js
git commit -m "Fix SUP-123"
git push -u origin fix/SUP-123
```

Do not commit `.env`, credentials, PM2 logs, or runtime state.
