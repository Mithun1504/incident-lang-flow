import json
import os
from typing import Any

from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data


class ValidateJiraDone(Component):
    display_name = "Check Jira Status"
    description = "Allows the PR branch only when the Jira issue is Done."
    icon = "circle-check"
    name = "ValidateJiraDone"

    inputs = [HandleInput(name="event", display_name="Parsed Jira Event", input_types=["Data", "JSON", "Message"], required=False)]
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
        expected = os.environ.get("JIRA_PR_TRIGGER_STATUS", "Done").strip() or "Done"
        event["eligible"] = bool(event.get("issue_key")) and str(event.get("status_name", "")).casefold() == expected.casefold()
        event["validation"] = "passed" if event["eligible"] else "ignored"
        return Data(data=event)
