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
        # Webhook/Message adapters can wrap JSON strings and materialize the
        # escaped newlines inside stack traces. Never discard Message.text
        # just because its data attribute is empty.
        for _ in range(12):
            if not isinstance(value, (dict, str)):
                data = getattr(value, "data", None)
                value = data if data else getattr(value, "text", None) or getattr(value, "default_value", None)
            if isinstance(value, str):
                text = value.strip()
                start, end = text.find("{"), text.rfind("}")
                candidates = [text]
                if start >= 0 and end > start:
                    candidates.append(text[start:end + 1])
                for candidate in candidates:
                    try:
                        value = json.loads(candidate, strict=False)
                        break
                    except (ValueError, TypeError):
                        continue
                else:
                    raise ValueError("Webhook payload must contain a JSON object")
                continue
            if isinstance(value, dict):
                for key in ("data", "payload", "incident"):
                    nested = value.get(key)
                    if isinstance(nested, (dict, str)) and nested:
                        value = nested
                        break
                else:
                    return value
                continue
            raise ValueError("Webhook payload must contain a JSON object")
        raise ValueError("Webhook payload has too many transport wrappers")

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
