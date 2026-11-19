const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const baseUrl = (process.env.LANGFLOW_BASE_URL || "http://localhost:7860").replace(/\/+$/, "");
const apiKey = process.env.LANGFLOW_API_KEY;
const componentPath = path.resolve(__dirname, "..", "langflow", "components", "github_pr_component.py");
const exportPath = path.resolve(__dirname, "..", "langflow", "flows", "jira_done_to_pr.json");

if (!apiKey) throw new Error("LANGFLOW_API_KEY is required");

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
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    throw new Error(`LangFlow API ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

function buildNode(sourceNode, code) {
  const id = "Webhook-jira-pr";
  return {
    ...sourceNode,
    id,
    data: {
      id,
      type: "CustomComponent",
      node: {
        display_name: "Jira Done to GitHub PR",
        description: "Creates a GitHub PR from fix/<JIRA-KEY> after a Jira issue reaches Done.",
        base_classes: ["Component", "Data"],
        template: {
          _type: "Component",
          code: { value: code, type: "code" },
          data: {
            _input_type: "MultilineInput",
            advanced: true,
            api_editable: false,
            display_name: "Jira Webhook Payload",
            input_types: [],
            name: "data",
            required: false,
            show: true,
            type: "str",
            value: "",
          },
        },
        outputs: [
          { name: "result", display_name: "Result Data", types: ["Data"], method: "process_event", selected: "Data" },
          { name: "issue_key", display_name: "Jira Issue Key", types: ["str"], method: "get_issue_key", selected: "str" },
          { name: "pr_url", display_name: "Pull Request URL", types: ["str"], method: "get_pr_url", selected: "str" },
        ],
      },
    },
  };
}

async function main() {
  const flows = await request(`${baseUrl}/api/v1/flows/`);
  const incidentFlow = flows.find((flow) => flow.name === "incident_to_jira");
  if (!incidentFlow?.data?.nodes?.length) throw new Error("incident_to_jira flow is required as a template");
  const templateNode = incidentFlow.data.nodes.find((node) => node.data?.type === "CustomComponent") || incidentFlow.data.nodes[0];
  const code = fs.readFileSync(componentPath, "utf8");
  const flow = {
    name: "jira_done_to_pr",
    description: "Create a GitHub PR from a manually pushed fix/<JIRA-KEY> branch when Jira reaches Done.",
    webhook: true,
    endpoint_name: "jira_done_to_pr",
    data: {
      nodes: [buildNode(templateNode, code)],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  };

  const existing = flows.find((item) => item.name === flow.name);
  let saved;
  if (existing?.id) {
    saved = await request(`${baseUrl}/api/v1/flows/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify(flow),
    });
  } else {
    saved = await request(`${baseUrl}/api/v1/flows/`, {
      method: "POST",
      body: JSON.stringify(flow),
    });
  }

  fs.writeFileSync(exportPath, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
  console.log(`Created or updated jira_done_to_pr flow ${saved.id || existing?.id || ""}`);
  console.log(`Webhook URL: ${baseUrl}/api/v1/webhook/jira_done_to_pr`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
