import json
from datetime import datetime
from typing import Any

from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data


class NormalizeIncident(Component):
    display_name = "Normalize Incident"
    description = "Converts the PM2-Log-Viewer event into the standard incident contract."
    icon = "braces"
    name = "NormalizeIncident"

    inputs = [HandleInput(name="input_data", display_name="Incident Event", input_types=["Data", "JSON", "Message"], required=False)]
    outputs = [Output(display_name="Normalized Incident", name="result", method="process")]

    @staticmethod
    def _dict(value: Any) -> dict:
        if hasattr(value, "data"):
            value = getattr(value, "data", None)
        if hasattr(value, "text") and not isinstance(value, dict):
            value = getattr(value, "text", "")
        if isinstance(value, dict):
            for key in ("data", "payload", "incident"):
                nested = value.get(key)
                if isinstance(nested, dict):
                    return nested
            return value
        if isinstance(value, str):
            text = value.strip()
            try:
                parsed = json.loads(text)
                return NormalizeIncident._dict(parsed)
            except Exception:
                start, end = text.find("{"), text.rfind("}")
                if start >= 0 and end > start:
                    try:
                        return NormalizeIncident._dict(json.loads(text[start:end + 1]))
                    except Exception:
                        pass
        return {}

    def process(self) -> Data:
        raw = self._dict(self.input_data)
        incident = {
            "source": raw.get("source") or raw.get("source_app") or "pm2-log-viewer",
            "service": raw.get("service") or "button-demo",
            "environment": raw.get("environment") or "local",
            "route": raw.get("route") or "unknown",
            "error_type": raw.get("error_type") or raw.get("name") or "UnknownError",
            "message": raw.get("message") or "No error message provided",
            "stack_trace": raw.get("stack_trace") or raw.get("stack") or "",
            "request_id": raw.get("request_id") or raw.get("requestId") or "req-unknown",
            "timestamp": raw.get("timestamp") or datetime.utcnow().isoformat(),
            "log_reference": raw.get("log_reference") or "pm2-log-viewer",
            "event_id": raw.get("event_id") or "",
        }
        if raw.get("fingerprint"):
            incident["fingerprint"] = raw["fingerprint"]
        return Data(data=incident)
