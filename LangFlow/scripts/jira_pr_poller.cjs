const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const baseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
const jiraEmail = process.env.JIRA_EMAIL || "";
const jiraToken = process.env.JIRA_API_TOKEN || "";
const projectKey = process.env.JIRA_PROJECT_KEY || "DEMO";
const triggerStatus = process.env.JIRA_PR_TRIGGER_STATUS || "Done";
const langflowUrl = process.env.LANGFLOW_WEBHOOK_URL || `${(process.env.LANGFLOW_BASE_URL || "http://localhost:7860").replace(/\/+$/, "")}/api/v1/webhook/${process.env.LANGFLOW_LIFECYCLE_ENDPOINT || "incident_to_jira"}`;
const langflowApiKey = process.env.LANGFLOW_API_KEY || "";
const intervalMs = Math.max(5000, Number(process.env.JIRA_PR_POLL_INTERVAL_MS || 15000));
const stateFile = path.resolve(__dirname, "..", process.env.JIRA_PR_POLLER_STATE_FILE || "runtime/jira-pr-poller-state.json");


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
    signal: AbortSignal.timeout(20000),
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

function issueQuery(issueKey = "") {
  if (issueKey && !new RegExp(`^${projectKey}-[0-9]+$`).test(issueKey)) {
    throw new Error("Test issue must belong to the configured Jira project");
  }
  const scope = issueKey ? `key = ${JSON.stringify(issueKey)}` : `project = ${JSON.stringify(projectKey)}`;
  return `${scope} AND status = ${JSON.stringify(triggerStatus)} AND labels = "automated-incident" ORDER BY updated ASC`;
}

async function findDoneIssues(issueKey = "") {
  const issues = [];
  let nextPageToken;
  do {
    const query = new URLSearchParams({ jql: issueQuery(issueKey), maxResults: "50", fields: "summary,status,comment,updated" });
    if (nextPageToken) query.set("nextPageToken", nextPageToken);
    const body = await jiraRequest(`/rest/api/3/search/jql?${query}`);
    issues.push(...(body.issues || []));
    nextPageToken = body.isLast === true ? null : body.nextPageToken;
  } while (nextPageToken);
  return issues;
}

async function runFlow(issue) {
  const response = await fetch(langflowUrl, {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json", "x-api-key": langflowApiKey },
    body: JSON.stringify({ event_type: "jira.status_changed", issue }),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`LangFlow ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}

// Polling Jira is cheap; launching a graph is reserved for a ready fix.
async function fixReadiness(issueKey) {
  const owner = process.env.GITHUB_OWNER;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !repository || !token) throw new Error("GitHub repository and token are required to check fix readiness");
  const branch = `${process.env.GITHUB_BRANCH_PREFIX || "fix/"}${issueKey}`;
  const base = process.env.GITHUB_BASE_BRANCH || "main";
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (response.status === 404) return { ready: false, reason: "branch_or_base_missing", branch };
  if (!response.ok) throw new Error(`GitHub readiness check HTTP ${response.status}`);
  const comparison = await response.json();
  return { ready: comparison.ahead_by > 0, reason: comparison.ahead_by > 0 ? "ready" : "no_commits", branch, sha: comparison.head_commit?.sha };
}

function retryDue(previous, revision, now = Date.now()) {
  return previous?.revision !== revision || !previous?.nextAttemptAt || Date.parse(previous.nextAttemptAt) <= now;
}
function retryDelay(attempts) {
  return Math.min(300000, 60000 * 2 ** Math.min(Math.max(0, attempts - 1), 3));
}

async function waitForPrComment(issueKey) {
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const issue = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=comment,status,updated`);
  const text = flattenAdf(issue.fields?.comment);
  return /GitHub PR .*https:\/\/github\.com\//i.test(text);
}

async function pollOnce(issueKey = "") {
  const issues = await findDoneIssues(issueKey);
  for (const issue of issues) {
    const key = issue.key;
    const existingText = flattenAdf(issue.fields?.comment);
    if (/GitHub PR .*https:\/\/github\.com\//i.test(existingText)) {
      state[key] = { status: "completed", updated: issue.fields?.updated || null };
      continue;
    }
    if (state[key]?.status === "completed" && state[key]?.updated === issue.fields?.updated) continue;

    let revision;
    let attempts = 0;
    try {
      const readiness = await fixReadiness(key);
      if (!readiness.ready) {
        if (state[key]?.reason !== readiness.reason) console.log(`[Jira PR Poller] ${key}: waiting for pushed fix (${readiness.reason}); flow not triggered`);
        state[key] = { status: "waiting_for_fix", reason: readiness.reason, updated: issue.fields?.updated || null };
        continue;
      }
      revision = `${issue.fields?.updated || ""}:${readiness.sha || ""}`;
      if (!retryDue(state[key], revision)) continue;
      attempts = state[key]?.revision === revision ? (state[key].attempts || 0) + 1 : 1;
      console.log(`[Jira PR Poller] Processing ${key} (${triggerStatus})`);
      await runFlow(issue);
      const complete = await waitForPrComment(key);
      state[key] = {
        status: complete ? "completed" : "pending",
        revision, attempts,
        nextAttemptAt: complete ? null : new Date(Date.now() + retryDelay(attempts)).toISOString(),
        updated: issue.fields?.updated || null,
        lastAttemptAt: new Date().toISOString(),
      };
      saveState();
      console.log(`[Jira PR Poller] ${key}: ${complete ? "PR confirmed" : "still pending"}`);
    } catch (error) {
      state[key] = { status: "pending", revision, attempts,
        nextAttemptAt: new Date(Date.now() + retryDelay(attempts || 1)).toISOString(),
        updated: issue.fields?.updated || null, lastError: error.message, lastAttemptAt: new Date().toISOString() };
      saveState();
      console.warn(`[Jira PR Poller] ${key} failed: ${error.message}`);
    }
  }
  saveState();
}

async function main() {
  if (!baseUrl || !jiraEmail || !jiraToken || !langflowApiKey) {
    throw new Error("Jira credentials and LangFlow API key are required");
  }
  loadState();
  const issueKey = (process.argv.find((arg) => arg.startsWith("--issue=")) || "").slice(8);
  console.log(`[Jira PR Poller] Watching ${projectKey} ${triggerStatus} issues every ${intervalMs}ms`);
  async function tick() {
    try { await pollOnce(issueKey); }
    catch (error) { console.warn(`[Jira PR Poller] Poll failed: ${error.message}`); }
    // Schedule only after the previous poll finishes, preventing overlap.
    if (!process.argv.includes("--once")) setTimeout(tick, intervalMs);
  }
  await tick();
}

module.exports = { issueQuery, findDoneIssues, pollOnce, runFlow, fixReadiness, retryDue, retryDelay };
if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
