import base64
import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Optional

from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data


class JiraTicketWriter(Component):
    display_name = "Create or Update Jira Ticket"
    description = "Searches by incident label, then creates or updates the configured Jira issue type."
    icon = "jira"
    name = "JiraTicketWriter"

    inputs = [HandleInput(name="incident", display_name="Fingerprinted Incident", input_types=["Data", "JSON", "Message"], required=False)]
    outputs = [Output(display_name="Jira Result", name="result", method="process")]

    def _call(self, endpoint: str, method: str = "GET", body: Optional[dict] = None) -> Any:
        base = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
        email = os.environ.get("JIRA_EMAIL", "").strip()
        token = os.environ.get("JIRA_API_TOKEN", "").strip()
        if not base or not email or not token:
            raise ValueError("Jira credentials are not configured")
        raw = base64.b64encode(f"{email}:{token}".encode()).decode()
        payload = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{base}{endpoint}",
            data=payload,
            headers={"Authorization": f"Basic {raw}", "Accept": "application/json", "Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                text = response.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace") if error.fp else ""
            raise RuntimeError(f"Jira API error ({error.code}): {detail[:500]}") from error

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

    @staticmethod
    def _text(value: Any) -> str:
        if isinstance(value, dict):
            return str(value.get("text") or "") + " " + " ".join(JiraTicketWriter._text(item) for item in value.get("content", []))
        return ""

    @staticmethod
    def _description(incident: dict, count: int) -> dict:
        lines = [
            f"Service: {incident.get('service')}",
            f"Incident Source: {incident.get('source')}",
            f"Environment: {incident.get('environment')}",
            f"Endpoint: {incident.get('route')}",
            f"Timestamp: {incident.get('timestamp')}",
            f"Request ID: {incident.get('request_id')}",
            f"Log Reference: {incident.get('log_reference')}",
            f"Occurrence Count: {count}",
            f"Error Fingerprint: {incident.get('fingerprint')}",
        ]
        content = [
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "What Failed"}]},
            {"type": "paragraph", "content": [{"type": "text", "text": f"{incident.get('error_type')}: {incident.get('message')}"}]},
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Incident Telemetry & Details"}]},
            {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": line}]}]} for line in lines]},
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Stack Trace"}]},
            {"type": "codeBlock", "attrs": {"language": "text"}, "content": [{"type": "text", "text": incident.get("stack_trace") or "No stack trace provided"}]},
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Likely Cause (Inference)"}]},
            {"type": "paragraph", "content": [{"type": "text", "text": f"[Inference / Likely Cause]: Inspect route '{incident.get('route')}' for the reported {incident.get('error_type')}. Developer confirmation is required."}]},
        ]
        return {"type": "doc", "version": 1, "content": content}

    def process(self) -> Data:
        incident = self._dict(self.incident)
        for field in ("route", "error_type", "message", "fingerprint"):
            if not incident.get(field):
                raise ValueError(f"Incident is missing {field}; refusing to create an empty ticket")
        project = os.environ.get("JIRA_PROJECT_KEY", "DEMO").strip()
        summary = f"{incident.get('service')} ({incident.get('environment')}): {incident.get('error_type')} on {incident.get('route')}"[:255]
        label = str(incident.get("dedup_label") or f"incident-{str(incident.get('fingerprint', ''))[:8]}")
        result = dict(incident)
        result["jira_label"] = label
        # A recurrence after completion is a new incident lifecycle. Use the
        # status category, since legacy completed issues may lack Resolution.
        search = self._call("/rest/api/3/search/jql", "POST", {"jql": f'project = "{project}" AND labels = "{label}" AND statusCategory != Done ORDER BY created DESC', "maxResults": 1, "fields": ["description", "summary"]})
        existing = (search.get("issues") or [None])[0]
        if existing:
            key = existing.get("key")
            evidence = self._text((existing.get("fields") or {}).get("description"))
            previous = re.search(r"Occurrence Count: (\d+)", evidence)
            count = int(previous.group(1)) if previous else 1
            if f"Request ID: {incident.get('request_id')} " in evidence:
                return Data(data={**result, "status": "unchanged", "action": "already_processed", "issue_key": key, "occurrence_count": count})
            count += 1
            comment = {"body": {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Duplicate incident occurrence #{count}; request {incident.get('request_id')}."}]}]}}
            self._call(f"/rest/api/3/issue/{key}/comment", "POST", comment)
            self._call(f"/rest/api/3/issue/{key}", "PUT", {"fields": {"summary": summary, "description": self._description(incident, count)}})
            result.update({"status": "updated", "action": "duplicate_updated", "issue_key": key, "occurrence_count": count})
        else:
            issue_type = os.environ.get("JIRA_ISSUE_TYPE", "Bug").strip()
            created = self._call("/rest/api/3/issue", "POST", {"fields": {"project": {"key": project}, "issuetype": {"name": issue_type}, "summary": summary, "description": self._description(incident, 1), "labels": ["automated-incident", "prototype", label]}})
            result.update({"status": "created", "action": "ticket_created", "issue_key": created.get("key"), "occurrence_count": 1})
        self.status = f"{result['action']}: {result['issue_key']} (occurrence {result['occurrence_count']})"
        return Data(data=result)
