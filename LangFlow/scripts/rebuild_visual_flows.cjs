const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const root = path.resolve(__dirname, '..');
const baseUrl = (process.env.LANGFLOW_BASE_URL || 'http://localhost:7860').replace(/\/+$/, '');
const endpoint = process.env.LANGFLOW_LIFECYCLE_ENDPOINT || 'incident_to_jira';
const staging = process.argv.includes('--staging');

async function request(url, options = {}) {
  if (!process.env.LANGFLOW_API_KEY) throw new Error('LANGFLOW_API_KEY is required');
  const response = await fetch(baseUrl + url, { ...options, signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': process.env.LANGFLOW_API_KEY, ...options.headers } });
  const text = await response.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`LangFlow ${response.status}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)}`);
  return body;
}
function field(name, label, value, handle = false) {
  return { _input_type: handle ? 'HandleInput' : 'StrInput', name, display_name: label, type: handle ? 'other' : 'str', value,
    input_types: handle ? ['Data', 'JSON', 'Message'] : [], required: handle, show: true, advanced: !handle, api_editable: false };
}
function custom(id, x, y, filename, className, title, description, icon, input, settings = {}, outputs = null) {
  let code = fs.readFileSync(path.join(root, 'langflow/components', filename), 'utf8');
  if (code.includes('from lifecycle_api import LifecycleAPI')) {
    code = fs.readFileSync(path.join(root, 'langflow/components/lifecycle_api.py'), 'utf8') + '\n\n' + code.replace('from lifecycle_api import LifecycleAPI', '');
  }
  const template = { _type: 'Component', code: { value: code, type: 'code' }, [input]: field(input, 'Input', '', true) };
  for (const [name, value] of Object.entries(settings)) template[name] = field(name, name.replaceAll('_', ' '), value);
  return { id, type: 'genericNode', position: { x, y }, data: { id, type: 'CustomComponent', node: { name: className, display_name: title, description, icon,
    base_classes: ['Component', 'Data'], template,
    outputs: outputs || [{ name: 'result', display_name: 'Result', types: ['Data'], selected: 'Data', method: 'process', value: '__UNDEFINED__', cache: true }] } },
    selected: false, width: 300, height: 220 };
}
function edge(source, target, fieldName, sourceName = 'result', sourceType = 'CustomComponent', types = ['Data'], label = '') {
  const from = { dataType: sourceType, id: source, name: sourceName, output_types: types };
  const to = { fieldName, id: target, inputTypes: ['Data', 'JSON', 'Message'], type: 'other' };
  const handle = object => JSON.stringify(object).replaceAll('"', 'œ');
  return { id: `${source}:${sourceName}->${target}:${fieldName}`, source, target, sourceHandle: handle(from), targetHandle: handle(to),
    data: { sourceHandle: from, targetHandle: to }, selected: false, ...(label ? { label } : {}) };
}
function note(id, x, y, width, height, description) {
  return { id, type: 'noteNode', position: { x, y }, data: { id, type: 'note', node: { description, display_name: '', template: { backgroundColor: '#edf3ff' } } },
    style: { width, height }, measured: { width, height }, width, height, selected: false, dragging: false };
}
function buildFlow(webhook, options = {}) {
  const trigger = options.trigger || process.env.JIRA_PR_TRIGGER_STATUS || 'Done';
  const prefix = options.prefix || process.env.GITHUB_BRANCH_PREFIX || 'fix/';
  const raised = options.raised ?? process.env.JIRA_PR_RAISED_STATUS ?? '';
  const hookId = 'Webhook-lifecycle';
  const hook = { id: hookId, type: 'genericNode', position: { x: 80, y: 160 }, data: { id: hookId, type: 'Webhook', node: JSON.parse(JSON.stringify(webhook)) }, width: 300, height: 220, selected: false };
  hook.data.node.id = hookId;
  hook.data.node.display_name = 'Receive Lifecycle Event';
  hook.data.node.description = 'One authenticated entry point for error events and Jira status changes.';
  // The editor's Run action is safe by default; real integrations supply payloads.
  hook.data.node.template.data.value = JSON.stringify({ event_type: 'preview' });
  const routerOutputs = ['incident', 'jira', 'ignored'].map((name, index) => ({ name,
    display_name: ['Application error', 'Jira status event', 'Ignored event'][index], method: ['incident_event', 'jira_event', 'ignored_event'][index],
    types: ['Data'], selected: 'Data', group_outputs: true, cache: true, value: '__UNDEFINED__' }));
  const nodes = [
    hook,
    custom('Route-lifecycle', 440, 160, 'flow_event_router.py', 'LifecycleEventRouter', 'Route Lifecycle Event', 'Selects one branch. Informational and incomplete events have no external side effects.', 'split', 'input_data', {}, routerOutputs),
    custom('Normalize-incident', 820, 0, 'flow_normalize_incident.py', 'NormalizeIncident', 'Normalize Error', 'Validate the error contract and preserve request correlation and stack evidence.', 'braces', 'input_data'),
    custom('Fingerprint-incident', 1180, 0, 'flow_fingerprint_incident.py', 'FingerprintIncident', 'Correlate Incident', 'Deterministic fingerprint links recurring failures to their active Jira incident.', 'fingerprint', 'incident'),
    custom('JiraTicket-incident', 1540, 0, 'flow_jira_ticket.py', 'JiraTicketWriter', 'Create or Update Jira', 'Create a new incident or update an active ticket. Completed incidents start a new lifecycle.', 'jira', 'incident'),
    custom('Handoff-incident', 1900, 0, 'flow_await_developer.py', 'AwaitDeveloper', 'Developer Handoff', 'End this event with the ticket and required fix branch. Resume here when Jira is resolved.', 'user-check', 'ticket', { trigger_status: trigger, branch_prefix: prefix }),
    custom('Parse-resolution', 820, 440, 'flow_parse_jira_event.py', 'ParseJiraEvent', 'Read Jira Update', 'Extract the issue key, summary, and status from the watcher or Jira webhook.', 'file-json', 'input_data'),
    custom('Validate-resolution', 1180, 440, 'flow_validate_jira_done.py', 'ValidateJiraDone', 'Check Resolution', `Only ${trigger} tickets are eligible to open a pull request.`, 'circle-check', 'event', { trigger_status: trigger }),
    custom('Prepare-resolution', 1540, 440, 'flow_prepare_pr.py', 'PreparePRContext', 'Prepare Fix Context', 'Use the configured repository, base branch, and ticket-specific developer branch.', 'git-branch', 'event', { branch_prefix: prefix }),
    custom('Verify-resolution', 1900, 440, 'flow_verify_branch.py', 'VerifyFixBranch', 'Verify Pushed Fix', 'Recheck the live Jira status, branch existence, and commits ahead of main.', 'shield-check', 'context'),
    custom('OpenPR-resolution', 1900, 800, 'flow_open_pr.py', 'OpenPullRequest', 'Open or Reuse PR', 'Create exactly one matching open pull request for the pushed developer branch.', 'github', 'context'),
    custom('LinkJira-resolution', 1540, 800, 'flow_link_jira.py', 'LinkPullRequestToJira', 'Link PR to Jira', 'Write the PR URL once and apply an optional supported Jira transition.', 'link', 'context', { raised_status: raised }),
    custom('Outcome-resolution', 1180, 800, 'flow_run_outcome.py', 'LifecycleOutcome', 'Lifecycle Result', 'Inspect the real outcome, Jira status, and PR URL for this execution.', 'flag', 'input_data'),
    custom('Ignored-lifecycle', 440, 800, 'flow_run_outcome.py', 'LifecycleOutcome', 'Ignored Event', 'Successful logs and unsupported events finish without creating tickets or PRs.', 'circle-minus', 'input_data'),
    note('note-overview', 80, -300, 650, 330, '# Incident lifecycle\n\n**One flow · two event types · one controlled outcome**\n\nApplication errors create a Jira incident. A developer implements and pushes the fix. The resolved Jira event returns to this same flow to verify the branch, open a PR, and link it back.\n\nInspect node outputs and Traces for real execution results. The handoff is a human step between runs, not a long-running background wait.'),
    note('note-intake', 820, -170, 1380, 120, '## 01 / Detect and record\nNormalize the failure → correlate it → create or update Jira → hand off to the developer.'),
    note('note-resolution', 820, 260, 1380, 130, `## 02 / Resolve and deliver\nDeveloper pushes **${prefix}<JIRA-KEY>**, then resolves the ticket to **${trigger}**. The watcher sends that event to this same webhook.`),
  ];
  const edges = [
    edge(hookId, 'Route-lifecycle', 'input_data', 'output_data', 'Webhook', ['JSON']),
    edge('Route-lifecycle', 'Normalize-incident', 'input_data', 'incident', 'CustomComponent', ['Data'], 'Application error'),
    edge('Route-lifecycle', 'Parse-resolution', 'input_data', 'jira', 'CustomComponent', ['Data'], 'Jira status event'),
    edge('Route-lifecycle', 'Ignored-lifecycle', 'input_data', 'ignored', 'CustomComponent', ['Data'], 'No action'),
    edge('Normalize-incident', 'Fingerprint-incident', 'incident'), edge('Fingerprint-incident', 'JiraTicket-incident', 'incident'),
    edge('JiraTicket-incident', 'Handoff-incident', 'ticket'), edge('Parse-resolution', 'Validate-resolution', 'event'),
    edge('Validate-resolution', 'Prepare-resolution', 'event'), edge('Prepare-resolution', 'Verify-resolution', 'context'),
    edge('Verify-resolution', 'OpenPR-resolution', 'context'), edge('OpenPR-resolution', 'LinkJira-resolution', 'context'),
    edge('LinkJira-resolution', 'Outcome-resolution', 'input_data'),
  ];
  return { name: staging ? 'Incident Lifecycle · Verification' : 'Incident Lifecycle', description: 'Error → Jira → developer fix → resolved Jira event → verified GitHub PR. One event-routed workflow with inspectable results.',
    webhook: true, endpoint_name: staging ? 'incident_lifecycle_preview' : endpoint,
    data: { nodes, edges, viewport: { x: 35, y: 240, zoom: 0.58 } } };
}
async function main() {
  const [catalog, flows] = await Promise.all([request('/api/v1/all'), request('/api/v1/flows/')]);
  const webhook = catalog?.input_output?.Webhook;
  if (!webhook) throw new Error('Installed LangFlow has no Webhook component');
  const flow = buildFlow(webhook);
  const existing = flows.find(f => f.endpoint_name === flow.endpoint_name);
  if (existing?.folder_id) flow.folder_id = existing.folder_id;
  const backupDir = path.join(root, 'runtime/flow-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  for (const old of flows.filter(f => ['incident_to_jira', 'jira_done_to_pr'].includes(f.endpoint_name))) {
    const file = path.join(backupDir, `${old.id}.json`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(old, null, 2) + '\n');
  }
  const saved = await request(existing ? `/api/v1/flows/${existing.id}` : '/api/v1/flows/', { method: existing ? 'PATCH' : 'POST', body: JSON.stringify(flow) });
  const file = path.join(root, 'langflow/flows', staging ? 'incident_lifecycle_preview.json' : 'incident_lifecycle.json');
  fs.writeFileSync(file, JSON.stringify(flow, null, 2) + '\n');
  console.log(`${flow.name}: 14 executable nodes, 13 connections, 3 explanatory notes`);
  console.log(`Flow ID: ${saved.id}; webhook: /api/v1/webhook/${flow.endpoint_name}`);
  if (process.argv.includes('--retire-legacy') && !staging) {
    for (const old of flows.filter(f => f.endpoint_name === 'jira_done_to_pr' || f.endpoint_name === 'incident_lifecycle_preview')) {
      if (old.id !== saved.id) { await request(`/api/v1/flows/${old.id}`, { method: 'DELETE' }); console.log(`Retired ${old.name}; local backup retained.`); }
    }
  }
}
module.exports = { buildFlow, edge, main };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
