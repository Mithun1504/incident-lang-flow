const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const baseUrl = (process.env.LANGFLOW_BASE_URL || "http://localhost:7860").replace(/\/+$/, "");
const apiKey = process.env.LANGFLOW_API_KEY;
const flowPath = path.resolve(__dirname, "..", "langflow", "flows", "incident_to_jira.json");

if (!apiKey) {
  throw new Error("LANGFLOW_API_KEY is required");
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`LangFlow API ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }

  return body;
}

async function main() {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const flows = await request(`${baseUrl}/api/v1/flows/`);
  const stored = flows.find((item) => item.name === "incident_to_jira");
  if (!stored?.id) {
    throw new Error("The incident_to_jira flow was not found in LangFlow");
  }

  const catalog = await request(`${baseUrl}/api/v1/all`);
  const webhookDefinition = catalog?.input_output?.Webhook;
  if (!webhookDefinition) {
    throw new Error("The installed LangFlow catalog does not contain the Webhook component");
  }

  const customNode = flow.data.nodes.find((node) => node.data?.type === "CustomComponent");
  if (!customNode) {
    throw new Error("The Jira custom-component node was not found");
  }

  const newId = customNode.id.includes("Webhook") ? customNode.id : "Webhook-jira";

  const existingOutputs = customNode.data.node.outputs || [];
  customNode.data.node.outputs = existingOutputs.map((output) => {
    if (output.name === "result") {
      return { ...output, method: "process_incident", selected: "Data" };
    }
    if (output.name === "issue_key") {
      return { ...output, method: "get_issue_key", selected: "str" };
    }
    return output;
  });

  const template = customNode.data.node.template || {};
  customNode.id = newId;
  customNode.data.id = newId;
  customNode.data.node.template = template;
  template.code = template.code || {};
  template.code.value = fs.readFileSync(path.resolve(__dirname, "..", "langflow", "components", "jira_incident_component.py"), "utf8");
  const webhookDataTemplate = webhookDefinition.template?.data;
  if (webhookDataTemplate) {
    template.data = { ...JSON.parse(JSON.stringify(webhookDataTemplate)), input_types: [], required: false };
  }
  template.repo_url = template.repo_url || {
    advanced: true,
    display_name: "Repository URL",
    info: "Optional git repository URL",
    input_types: [],
    list: false,
    name: "repo_url",
    required: false,
    show: true,
    type: "str",
    value: "",
  };
  template.commit_sha = template.commit_sha || {
    advanced: true,
    display_name: "Commit SHA",
    info: "Optional commit SHA reference",
    input_types: [],
    list: false,
    name: "commit_sha",
    required: false,
    show: true,
    type: "str",
    value: "",
  };
  customNode.data.node.template = template;

  flow.data.nodes = [customNode];
  flow.data.edges = [];
  flow.data.viewport = flow.data.viewport || { x: 0, y: 0, zoom: 1 };
  flow.name = "incident_to_jira";
  flow.endpoint_name = "incident_to_jira";
  flow.webhook = true;

  fs.writeFileSync(flowPath, `${JSON.stringify(flow, null, 2)}\n`, "utf8");

  await request(`${baseUrl}/api/v1/flows/${stored.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: flow.name,
      description: flow.description,
      data: flow.data,
      endpoint_name: flow.endpoint_name,
    }),
  });

  console.log(`Repaired incident_to_jira flow ${stored.id}`);
  console.log(`Webhook component: ${newId}`);
  console.log(`Webhook URL: ${baseUrl}/api/v1/webhook/incident_to_jira`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
