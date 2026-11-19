const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const baseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
const jiraEmail = process.env.JIRA_EMAIL || "";
const jiraToken = process.env.JIRA_API_TOKEN || "";
const projectKey = process.env.JIRA_PROJECT_KEY || "DEMO";
const langflowUrl = `${(process.env.LANGFLOW_BASE_URL || "http://localhost:7860").replace(/\/+$/, "")}/api/v1/webhook/jira_done_to_pr`;
const langflowApiKey = process.env.LANGFLOW_API_KEY || "";
const intervalMs = Math.max(5000, Number(process.env.JIRA_PR_POLL_INTERVAL_MS || 15000));
const stateFile = path.resolve(__dirname, "..", process.env.JIRA_PR_POLLER_STATE_FILE || "runtime/jira-pr-poller-state.json");

if (!baseUrl || !jiraEmail || !jiraToken || !langflowApiKey) {
  throw new Error("Jira credentials, LangFlow API key, and LangFlow base URL are required");
}

const jiraAuth = `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString("base64")}`;
let state = {};

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    state = {};
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temp, stateFile);
}

async function jiraRequest(endpoint, options = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      Authorization: jiraAuth,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`Jira ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

function flattenAdf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenAdf).join(" ");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => key === "text" ? String(item) : flattenAdf(item)).join(" ");
  return String(value);
}

async function findDoneIssues() {
  const jql = `project = ${projectKey} AND status = \"Done\" ORDER BY updated ASC`;
  const body = await jiraRequest(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,status,comment,updated`);
  return body.issues || [];
}

async function runFlow(issue) {
  const response = await fetch(langflowUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": langflowApiKey },
    body: JSON.stringify({ issue }),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`LangFlow ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}

async function waitForPrComment(issueKey) {
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const issue = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=comment,status,updated`);
  const text = flattenAdf(issue.fields?.comment);
  return /GitHub PR .*https:\/\/github\.com\//i.test(text);
}

async function pollOnce() {
  const issues = await findDoneIssues();
  for (const issue of issues) {
    const key = issue.key;
    const existingText = flattenAdf(issue.fields?.comment);
    if (/GitHub PR .*https:\/\/github\.com\//i.test(existingText)) {
      state[key] = { status: "completed", updated: issue.fields?.updated || null };
      continue;
    }
    if (state[key]?.status === "completed" && state[key]?.updated === issue.fields?.updated) continue;

    try {
      console.log(`[Jira PR Poller] Processing ${key} (Done)`);
      await runFlow(issue);
      const complete = await waitForPrComment(key);
      state[key] = {
        status: complete ? "completed" : "pending",
        updated: issue.fields?.updated || null,
        lastAttemptAt: new Date().toISOString(),
      };
      saveState();
      console.log(`[Jira PR Poller] ${key}: ${complete ? "PR confirmed" : "still pending"}`);
    } catch (error) {
      state[key] = { status: "pending", updated: issue.fields?.updated || null, lastError: error.message, lastAttemptAt: new Date().toISOString() };
      saveState();
      console.warn(`[Jira PR Poller] ${key} failed: ${error.message}`);
    }
  }
  saveState();
}

async function main() {
  loadState();
  console.log(`[Jira PR Poller] Watching ${projectKey} Done issues every ${intervalMs}ms`);
  await pollOnce();
  setInterval(() => pollOnce().catch((error) => console.warn(`[Jira PR Poller] Poll failed: ${error.message}`)), intervalMs);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
