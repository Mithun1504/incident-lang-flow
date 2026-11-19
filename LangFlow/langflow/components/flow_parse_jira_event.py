import json
from typing import Any

from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data


class ParseJiraEvent(Component):
    display_name = "Parse Jira Event"
    description = "Extracts the Jira issue and status from a webhook payload."
    icon = "file-json"
    name = "ParseJiraEvent"

    inputs = [HandleInput(name="input_data", display_name="Jira Webhook Event", input_types=["Data", "JSON", "Message"], required=False)]
    outputs = [Output(display_name="Parsed Jira Event", name="result", method="process")]

    @staticmethod
    def _dict(value: Any) -> dict:
        if hasattr(value, "data"):
            value = getattr(value, "data", None)
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                return json.loads(value)
            except Exception:
                return {}
        return {}

    def process(self) -> Data:
        payload = self._dict(self.input_data)
        issue = payload.get("issue") if isinstance(payload.get("issue"), dict) else payload
        fields = issue.get("fields") if isinstance(issue.get("fields"), dict) else {}
        status = fields.get("status") if isinstance(fields.get("status"), dict) else {}
        result = dict(payload)
        result["issue"] = issue
        result["issue_key"] = str(issue.get("key") or payload.get("issue_key") or "").strip()
        result["status_name"] = str(status.get("name") or payload.get("status") or payload.get("status_name") or "").strip()
        result["summary"] = str(fields.get("summary") or f"Fix {result['issue_key']}").strip()
        return Data(data=result)
