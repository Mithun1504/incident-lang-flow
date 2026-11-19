const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const baseUrl = (process.env.LANGFLOW_BASE_URL || "http://localhost:7860").replace(/\/+$/, "");
const apiKey = process.env.LANGFLOW_API_KEY;
if (!apiKey) throw new Error("LANGFLOW_API_KEY is required");

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", "Content-Type": "application/json", "x-api-key": apiKey, ...(options.headers || {}) },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`LangFlow API ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function inputField(name, displayName) {
  return {
    _input_type: "HandleInput",
    advanced: false,
    api_editable: false,
    display_name: displayName,
    info: "Data passed from the previous flow stage.",
    input_types: ["Data", "JSON", "Message"],
    list: false,
    name,
    required: false,
    show: true,
    type: "other",
    value: "",
  };
}

function customNode(id, position, code, className, displayName, inputName, inputDisplay) {
  return {
    id,
    type: "genericNode",
    position,
    data: {
      id,
      type: "CustomComponent",
      node: {
        display_name: displayName,
        description: "A single responsibility in the incident automation pipeline.",
        icon: "workflow",
        name: className,
        base_classes: ["Component", "Data"],
        template: { _type: "Component", code: { value: code, type: "code" }, [inputName]: inputField(inputName, inputDisplay) },
        outputs: [{ name: "result", display_name: "Result", types: ["Data"], selected: "Data", method: "process", value: "__UNDEFINED__", cache: true }],
      },
    },
    selected: false,
    width: 360,
    height: 260,
  };
}

function webhookNode(id, position, definition) {
  const node = clone(definition);
  node.id = id;
  return {
    id,
    type: "genericNode",
    position,
    data: { id, type: "Webhook", node },
    selected: false,
    width: 360,
    height: 280,
  };
}

function handle(value) {
  return JSON.stringify(value).replaceAll('"', "œ");
}

function connect(source, sourceType, sourceName, target, targetName, sourceTypes = ["Data"]) {
  const sourceHandle = handle({ dataType: sourceType, id: source, name: sourceName, output_types: sourceTypes });
  const targetHandle = handle({ fieldName: targetName, id: target, inputTypes: ["Data"], type: "other" });
  return {
    source,
    target,
    sourceHandle,
    targetHandle,
    id: `reactflow__edge-${source}${sourceHandle}-${target}${targetHandle}`,
    data: {
      sourceHandle: { dataType: sourceType, id: source, name: sourceName, output_types: sourceTypes },
      targetHandle: { fieldName: targetName, id: target, inputTypes: ["Data"], type: "other" },
    },
    selected: false,
    className: "",
  };
}

function visualFlow(name, description, endpointName, nodes, edges) {
  return { name, description, webhook: true, endpoint_name: endpointName, data: { nodes, edges, viewport: { x: 0, y: 0, zoom: 0.8 } } };
}

async function saveFlow(flow, storedFlows) {
  const existing = storedFlows.find((item) => item.name === flow.name);
  const saved = existing?.id
    ? await request(`${baseUrl}/api/v1/flows/${existing.id}`, { method: "PATCH", body: JSON.stringify(flow) })
    : await request(`${baseUrl}/api/v1/flows/`, { method: "POST", body: JSON.stringify(flow) });
  const filename = path.resolve(__dirname, "..", "langflow", "flows", `${flow.name}.json`);
  fs.writeFileSync(filename, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
  console.log(`${flow.name}: ${flow.data.nodes.length} nodes, ${flow.data.edges.length} edges (${saved.id || existing?.id || "saved"})`);
}

async function main() {
  const [catalog, flows] = await Promise.all([
    request(`${baseUrl}/api/v1/all`),
    request(`${baseUrl}/api/v1/flows/`),
  ]);
  const webhook = catalog?.input_output?.Webhook;
  if (!webhook) throw new Error("Webhook component is unavailable");

  const incidentCode = fs.readFileSync(path.resolve(__dirname, "..", "langflow", "components", "flow_normalize_incident.py"), "utf8");
  const fingerprintCode = fs.readFileSync(path.resolve(__dirname, "..", "langflow", "components", "flow_fingerprint_incident.py"), "utf8");
  const ticketCode = fs.readFileSync(path.resolve(__dirname, "..", "langflow", "components", "flow_jira_ticket.py"), "utf8");
  const incidentNodes = [
    webhookNode("Webhook-incident", { x: 80, y: 220 }, webhook),
    customNode("NormalizeIncident-incident", { x: 500, y: 220 }, incidentCode, "NormalizeIncident", "Normalize Incident", "input_data", "Incident Event"),
    customNode("FingerprintIncident-incident", { x: 920, y: 220 }, fingerprintCode, "FingerprintIncident", "Fingerprint Incident", "incident", "Normalized Incident"),
    customNode("JiraTicketWriter-incident", { x: 1340, y: 220 }, ticketCode, "JiraTicketWriter", "Create or Update Jira Ticket", "incident", "Fingerprinted Incident"),
  ];
  const incidentEdges = [
    connect("Webhook-incident", "Webhook", "output_data", "NormalizeIncident-incident", "input_data", ["JSON"]),
    connect("NormalizeIncident-incident", "NormalizeIncident", "result", "FingerprintIncident-incident", "incident"),
    connect("FingerprintIncident-incident", "FingerprintIncident", "result", "JiraTicketWriter-incident", "incident"),
  ];

  const parseCode = fs.readFileSync(path.resolve(__dirname, "..", "langflow", "components", "flow_parse_jira_event.py"), "utf8");
  const validateCode = fs.readFileSync(path.resolve(__dirname, "..", "langflow", "components", "flow_validate_jira_done.py"), "utf8");
  const prepareCode = fs.readFileSync(path.resolve(__dirname, "..", "langflow", "components", "flow_prepare_pr.py"), "utf8");
  const createCode = fs.readFileSync(path.resolve(__dirname, "..", "langflow", "components", "flow_create_pr.py"), "utf8");
  const prNodes = [
    webhookNode("Webhook-jira-pr", { x: 80, y: 220 }, webhook),
    customNode("ParseJiraEvent-pr", { x: 500, y: 220 }, parseCode, "ParseJiraEvent", "Parse Jira Event", "input_data", "Jira Webhook Event"),
    customNode("ValidateJiraDone-pr", { x: 920, y: 220 }, validateCode, "ValidateJiraDone", "Check Jira Status", "event", "Parsed Jira Event"),
    customNode("PreparePRContext-pr", { x: 1340, y: 220 }, prepareCode, "PreparePRContext", "Prepare PR Context", "event", "Validated Jira Event"),
    customNode("CreateGitHubPR-pr", { x: 1760, y: 220 }, createCode, "CreateGitHubPR", "Create GitHub PR", "context", "PR Context"),
  ];
  const prEdges = [
    connect("Webhook-jira-pr", "Webhook", "output_data", "ParseJiraEvent-pr", "input_data", ["JSON"]),
    connect("ParseJiraEvent-pr", "ParseJiraEvent", "result", "ValidateJiraDone-pr", "event"),
    connect("ValidateJiraDone-pr", "ValidateJiraDone", "result", "PreparePRContext-pr", "event"),
    connect("PreparePRContext-pr", "PreparePRContext", "result", "CreateGitHubPR-pr", "context"),
  ];

  await saveFlow(visualFlow("incident_to_jira", "PM2-Log-Viewer webhook → normalize → fingerprint → create or update Jira", "incident_to_jira", incidentNodes, incidentEdges), flows);
  await saveFlow(visualFlow("jira_done_to_pr", "Jira webhook → parse → validate Done → prepare branch → create GitHub PR", "jira_done_to_pr", prNodes, prEdges), flows);
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
