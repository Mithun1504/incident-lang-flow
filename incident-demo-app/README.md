# Incident Demo App

Four-button Express application used as the developer-facing demo repository
for the incident automation prototype.

## Run locally

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Open `http://localhost:3000`.

The two success buttons return HTTP 200 and change the page colour. The two
failure buttons return HTTP 500 and write structured JSON errors to stderr so
PM2 can capture them.

## Developer fix workflow

For Jira issue `DEMO-123`, create and push:

```bash
git checkout -b fix/DEMO-123
# make the fix
git add .
git commit -m "Fix DEMO-123"
git push origin fix/DEMO-123
```

After the branch is pushed, mark the Jira issue `Done`. The LangFlow PR flow
checks for `fix/DEMO-123` and creates a pull request into `main`.

Do not commit `.env`, PM2 logs, runtime state, or credentials.
