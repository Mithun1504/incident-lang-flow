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
        raw = self._dict(self.input_data)
        missing = [key for key in ("route", "error_type", "message") if not isinstance(raw.get(key), str) or not raw[key].strip()]
        if missing:
            raise ValueError("Incident is missing required fields: " + ", ".join(missing))
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
