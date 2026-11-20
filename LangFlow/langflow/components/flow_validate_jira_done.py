import json
import os
from typing import Any

from langflow.custom import Component
from langflow.io import HandleInput, Output, StrInput
from langflow.schema import Data


class ValidateJiraDone(Component):
    display_name = "Check Jira Status"
    description = "Allows the PR branch only when the Jira issue is Done."
    icon = "circle-check"
    name = "ValidateJiraDone"

    inputs = [
        HandleInput(name="event", display_name="Parsed Jira Event", input_types=["Data", "JSON", "Message"], required=False),
        StrInput(name="trigger_status", display_name="PR Trigger Status", value="Done"),
    ]
    outputs = [Output(display_name="Validated Event", name="result", method="process")]

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
        event = self._dict(self.event)
        expected = str(self.trigger_status or os.environ.get("JIRA_PR_TRIGGER_STATUS", "Done")).strip()
        event["trigger_status"] = expected
        event["eligible"] = bool(event.get("issue_key")) and str(event.get("status_name", "")).casefold() == expected.casefold()
        event["validation"] = "passed" if event["eligible"] else "ignored"
        self.status = f"{event.get('issue_key')}: {event.get('status_name')} — {event['validation']}"
        return Data(data=event)
