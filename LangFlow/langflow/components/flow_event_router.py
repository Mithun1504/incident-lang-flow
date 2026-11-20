import json
from typing import Any
from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data


class LifecycleEventRouter(Component):
    display_name = "Route Lifecycle Event"
    description = "Classifies error and Jira events; excludes every inactive branch."
    icon = "split"
    name = "LifecycleEventRouter"
    inputs = [HandleInput(name="input_data", display_name="Incoming Event", input_types=["Data", "JSON", "Message"], required=False)]
    outputs = [
        Output(display_name="Application error", name="incident", method="incident_event", group_outputs=True),
        Output(display_name="Jira status event", name="jira", method="jira_event", group_outputs=True),
        Output(display_name="Ignored event", name="ignored", method="ignored_event", group_outputs=True),
    ]

    @staticmethod
    def _dict(value: Any) -> dict:
        # Webhook/Message adapters can wrap JSON strings and materialize the
        # escaped newlines inside stack traces. Never discard Message.text
        # just because its data attribute is empty.
        for _ in range(12):
            if not isinstance(value, (dict, str)):
                data = getattr(value, "data", None)
                value = data if isinstance(data, dict) else getattr(value, "text", None) or getattr(value, "default_value", None)
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

    def _route(self, output):
        raw = self._dict(self.input_data)
        declared = raw.get("event_type")
        has_issue = isinstance(raw.get("issue"), dict) or bool(raw.get("issue_key"))
        has_incident = all(raw.get(key) for key in ("route", "error_type", "message"))
        if has_issue and has_incident:
            raise ValueError("Ambiguous event: Jira and incident data cannot share one event")
        if declared not in (None, "incident", "jira.status_changed", "preview"):
            kind, reason = "ignored", "unsupported_event_type"
        elif has_issue and declared in (None, "jira.status_changed"):
            kind, reason = "jira", "jira_status_event"
        elif has_incident and raw.get("level", "error") == "error" and declared in (None, "incident"):
            kind, reason = "incident", "application_error"
        else:
            kind, reason = "ignored", "non_error_or_incomplete_event"
        for other in ("incident", "jira", "ignored"):
            if other != kind:
                self.stop(other)
                # Match the installed native If-Else routing semantics.
                if getattr(self, "graph", None):
                    self.graph.exclude_branch_conditionally(self._id, output_name=other)
        self.status = f"Selected {kind}: {reason}"
        if output != kind:
            return Data(data={})
        return Data(data={**raw, "event_type": "jira.status_changed" if kind == "jira" else kind, "route_reason": reason})

    def incident_event(self) -> Data:
        return self._route("incident")

    def jira_event(self) -> Data:
        return self._route("jira")

    def ignored_event(self) -> Data:
        return self._route("ignored")
