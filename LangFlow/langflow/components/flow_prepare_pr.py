import json
import os
from typing import Any

from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data


class PreparePRContext(Component):
    display_name = "Prepare PR Context"
    description = "Builds the fixed repository and fix/<JIRA-KEY> branch context."
    icon = "git-pull-request"
    name = "PreparePRContext"

    inputs = [HandleInput(name="event", display_name="Validated Jira Event", input_types=["Data", "JSON", "Message"], required=False)]
    outputs = [Output(display_name="PR Context", name="result", method="process")]

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
        key = str(event.get("issue_key") or "").strip()
        event.update({
            "owner": os.environ.get("GITHUB_OWNER", "anuraag-bagepalli").strip(),
            "repository": os.environ.get("GITHUB_REPOSITORY", "incident-demo-app").strip(),
            "base_branch": os.environ.get("GITHUB_BASE_BRANCH", "main").strip() or "main",
            "branch": f"fix/{key}" if key else "",
        })
        return Data(data=event)
