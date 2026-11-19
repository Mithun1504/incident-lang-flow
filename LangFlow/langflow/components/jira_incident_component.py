import os
import json
import base64
import hashlib
import urllib.request
import urllib.error
from datetime import datetime
from typing import Any, Dict, Optional

from langflow.custom import Component
from langflow.io import MultilineInput, Output, DataInput, StrInput
from langflow.schema import Data


class JiraIncidentComponent(Component):
    display_name = "Jira Incident Handler"
    description = "Parses incident data, deduplicates by fingerprint, and creates or updates Jira Bug tickets using Jira REST API v3 without an LLM."
    icon = "jira"
    name = "JiraIncidentComponent"

    inputs = [
        MultilineInput(
            name="data",
            display_name="Webhook Payload",
            info="Raw JSON body injected by the LangFlow webhook endpoint.",
            advanced=True,
            input_types=[],
            required=False,
        ),
        DataInput(
            name="incident_input",
            display_name="Incident Data / Webhook Event",
            info="Incoming incident event from the Webhook or collector",
            required=False
        ),
        StrInput(
            name="repo_url",
            display_name="Repository URL",
            info="Optional git repository URL",
            value="https://github.com/Ellipsonic/incident-prototype",
            advanced=True
        ),
        StrInput(
            name="commit_sha",
            display_name="Commit SHA",
            info="Optional commit SHA reference",
            value="local-prototype-head",
            advanced=True
        )
    ]

    outputs = [
        Output(display_name="Result Data", name="result", method="process_incident"),
        Output(display_name="Jira Issue Key", name="issue_key", method="get_issue_key")
    ]

    def _get_jira_auth_header(self, email: str, token: str) -> str:
        credentials = f"{email}:{token}".encode("utf-8")
        base64_cred = base64.b64encode(credentials).decode("utf-8")
        return f"Basic {base64_cred}"

    def _call_jira_api(self, endpoint: str, method: str = "GET", body: Optional[dict] = None) -> Dict[str, Any]:
        base_url = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
        email = os.environ.get("JIRA_EMAIL", "").strip()
        token = os.environ.get("JIRA_API_TOKEN", "").strip()

        if not base_url or not email or not token:
            raise ValueError("Missing required Jira environment variables: JIRA_BASE_URL, JIRA_EMAIL, or JIRA_API_TOKEN")

        url = f"{base_url}{endpoint}"
        headers = {
            "Authorization": self._get_jira_auth_header(email, token),
            "Accept": "application/json",
            "Content-Type": "application/json"
        }

        data_bytes = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp_text = resp.read().decode("utf-8")
                return json.loads(resp_text) if resp_text else {}
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8") if e.fp else ""
            raise RuntimeError(f"Jira API error ({e.code}) on {method} {endpoint}: {err_body}")
        except Exception as e:
            raise RuntimeError(f"Network error calling Jira API {method} {endpoint}: {str(e)}")

    def _compute_fingerprint(self, incident: dict) -> str:
        service = str(incident.get("service") or "button-demo").strip().lower()
        route = str(incident.get("route") or "unknown").strip()
        error_type = str(incident.get("error_type") or "Error").strip()
        message = str(incident.get("message") or "unknown").strip()
        key_str = f"{service}|{route}|{error_type}|{message}"
        return hashlib.sha256(key_str.encode("utf-8")).hexdigest()

    def _build_adf_description(self, incident: dict, occurrence_count: int, repo_url: str, commit_sha: str) -> dict:
        likely_cause = (
            f"[Inference / Likely Cause]: Backend exception triggered during execution of route '{incident.get('route')}'. "
            f"The error type '{incident.get('error_type')}' indicates an intentional or unhandled application fault: '{incident.get('message')}'. "
            f"Developer action required: inspect the route controller and add defensive error handling."
        )

        return {
            "type": "doc",
            "version": 1,
            "content": [
                {
                    "type": "heading",
                    "attrs": {"level": 2},
                    "content": [{"type": "text", "text": "What Failed"}]
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": f"{incident.get('error_type')}: {incident.get('message')}"}]
                },
                {
                    "type": "heading",
                    "attrs": {"level": 2},
                    "content": [{"type": "text", "text": "Incident Telemetry & Details"}]
                },
                {
                    "type": "bulletList",
                    "content": [
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Service: {incident.get('service')}"}]}]},
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Incident Source: {incident.get('source')}"}]}]},
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Environment: {incident.get('environment')}"}]}]},
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Endpoint: {incident.get('route')}"}]}]},
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Timestamp: {incident.get('timestamp')}"}]}]},
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Request ID: {incident.get('request_id')}"}]}]},
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Log Reference: {incident.get('log_reference')}"}]}]},
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Repository: {repo_url}"}]}]},
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Commit SHA: {commit_sha}"}]}]},
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Occurrence Count: {occurrence_count}"}]}]},
                        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"Error Fingerprint: {incident.get('fingerprint')}"}]}]}
                    ]
                },
                {
                    "type": "heading",
                    "attrs": {"level": 2},
                    "content": [{"type": "text", "text": "Stack Trace"}]
                },
                {
                    "type": "codeBlock",
                    "attrs": {"language": "text"},
                    "content": [{"type": "text", "text": incident.get("stack_trace") or "No stack trace provided"}]
                },
                {
                    "type": "heading",
                    "attrs": {"level": 2},
                    "content": [{"type": "text", "text": "Likely Cause (Inference)"}]
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": likely_cause}]
                }
            ]
        }

    @staticmethod
    def _parse_json_text(value: str) -> Optional[dict]:
        """Parse webhook text, including LangFlow's prefixed/wrapped form."""
        text = str(value or "").strip()
        candidates = [text]
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            candidates.append(text[start:end + 1])

        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass

            # Some LangFlow message coercions turn escaped JSON newlines into
            # literal control characters inside a JSON string. Escape those
            # controls only while inside quoted JSON text, then retry.
            sanitized = []
            in_string = False
            escaped = False
            for char in candidate:
                if char == '"' and not escaped:
                    in_string = not in_string
                if in_string and char in "\r\n\t":
                    sanitized.append({"\r": "\\r", "\n": "\\n", "\t": "\\t"}[char])
                else:
                    sanitized.append(char)
                if char == "\\" and not escaped:
                    escaped = True
                else:
                    escaped = False
            try:
                parsed = json.loads("".join(sanitized))
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
        return None

    def process_incident(self) -> Data:
        # Extract incident dictionary from input
        raw_data = self.data or self.incident_input
        if hasattr(raw_data, "data"):
            # LangFlow may coerce a webhook string into a Message.  In that
            # case ``Message.data`` is usually empty and the JSON body is in
            # ``text``/``default_value`` instead.
            candidate = getattr(raw_data, "data", None)
            if isinstance(candidate, dict) and candidate:
                incident = candidate
            else:
                text_value = getattr(raw_data, "text", None) or getattr(raw_data, "default_value", None)
                if isinstance(text_value, str):
                    incident = self._parse_json_text(text_value) or {"message": text_value}
                else:
                    incident = {}
        elif isinstance(raw_data, dict):
            incident = raw_data
        elif isinstance(raw_data, str):
            incident = self._parse_json_text(raw_data) or {"message": raw_data}
        else:
            try:
                incident = dict(raw_data)
            except Exception:
                incident = {}

        # LangFlow's Webhook/Data adapters can wrap the JSON body one or more
        # times (for example {"data": { ...incident... }}). Unwrap those
        # transport envelopes before normalizing so route/message/source are
        # preserved from PM2-Log-Viewer.
        for _ in range(3):
            if not isinstance(incident, dict):
                break
            nested = None
            for wrapper_key in ("data", "payload", "incident"):
                candidate = incident.get(wrapper_key)
                if isinstance(candidate, dict):
                    nested = candidate
                    break
                if isinstance(candidate, str) and candidate.strip().startswith("{"):
                    try:
                        nested = json.loads(candidate)
                    except Exception:
                        nested = None
                    if isinstance(nested, dict):
                        break
            if not isinstance(nested, dict) or nested is incident:
                break
            incident = nested

        # Normalize required fields
        service = incident.get("service") or os.environ.get("SERVICE_NAME", "button-demo")
        source = incident.get("source") or incident.get("source_app") or "unknown-source"
        environment = incident.get("environment") or os.environ.get("ENVIRONMENT", "local")
        route = incident.get("route", "unknown")
        error_type = incident.get("error_type", "IntentionalPrototypeError")
        message = incident.get("message", "Prototype test error")
        stack_trace = incident.get("stack_trace", "")
        request_id = incident.get("request_id", "req-unknown")
        timestamp = incident.get("timestamp") or datetime.utcnow().isoformat()
        log_reference = incident.get("log_reference", "runtime/pm2/button-demo-error.log")

        incident_norm = {
            "source": source,
            "service": service,
            "environment": environment,
            "route": route,
            "error_type": error_type,
            "message": message,
            "stack_trace": stack_trace,
            "request_id": request_id,
            "timestamp": timestamp,
            "log_reference": log_reference
        }

        # Deterministic SHA-256 fingerprint
        fingerprint = incident.get("fingerprint") or self._compute_fingerprint(incident_norm)
        fingerprint_prefix = fingerprint[:8]
        incident_norm["fingerprint"] = fingerprint
        incident_norm["fingerprint_prefix"] = fingerprint_prefix

        project_key = os.environ.get("JIRA_PROJECT_KEY", "DEMO").strip()
        issue_type = os.environ.get("JIRA_ISSUE_TYPE", "Bug").strip()
        repo_url = self.repo_url or "https://github.com/Ellipsonic/incident-prototype"
        commit_sha = self.commit_sha or "local-prototype-head"

        dedup_label = f"incident-{fingerprint_prefix}"
        labels = ["automated-incident", "prototype", dedup_label]

        # Step: Check for existing duplicate Jira issue using Jira REST API v3 search/jql
        jql = f'labels = "{dedup_label}" ORDER BY created DESC'
        search_body = {
            "jql": jql,
            "maxResults": 1,
            "fields": ["summary", "description", "labels", "comment"]
        }

        existing_issue = None
        try:
            search_result = self._call_jira_api("/rest/api/3/search/jql", method="POST", body=search_body)
            issues = search_result.get("issues", [])
            if issues:
                existing_issue = issues[0]
        except Exception as e:
            # Record diagnostic if search fails
            return Data(data={
                "status": "error",
                "stage": "search",
                "fingerprint": fingerprint,
                "error_detail": str(e)
            })

        if existing_issue:
            # Duplicate detected -> Update existing Jira issue
            issue_key = existing_issue.get("key")
            
            # Extract previous occurrence count from comments
            comments = existing_issue.get("fields", {}).get("comment", {}).get("comments", [])
            occurrence_count = len(comments) + 2

            comment_body = {
                "body": {
                    "type": "doc",
                    "version": 1,
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [
                                {
                                    "type": "text",
                                    "text": f"[Duplicate Occurrence #{occurrence_count}] Incident recurred at {timestamp}.\n"
                                            f"Request ID: {request_id}\n"
                                            f"Route: {route}\n"
                                            f"Fingerprint: {fingerprint}"
                                }
                            ]
                        }
                    ]
                }
            }

            try:
                self._call_jira_api(f"/rest/api/3/issue/{issue_key}/comment", method="POST", body=comment_body)
            except Exception:
                pass

            update_body = {
                "fields": {
                    "description": self._build_adf_description(incident_norm, occurrence_count, repo_url, commit_sha)
                }
            }
            try:
                self._call_jira_api(f"/rest/api/3/issue/{issue_key}", method="PUT", body=update_body)
            except Exception:
                pass

            self._last_issue_key = issue_key
            return Data(data={
                "status": "updated",
                "action": "duplicate_updated",
                "issue_key": issue_key,
                "occurrence_count": occurrence_count,
                "fingerprint": fingerprint,
                "request_id": request_id
            })

        else:
            # New incident -> Create new Jira Bug ticket
            summary = f"[Incident][{service}][{environment}] {error_type} in {route} ({fingerprint_prefix})"
            create_body = {
                "fields": {
                    "project": {"key": project_key},
                    "issuetype": {"name": issue_type},
                    "summary": summary,
                    "description": self._build_adf_description(incident_norm, 1, repo_url, commit_sha),
                    "labels": labels
                }
            }

            try:
                create_res = self._call_jira_api("/rest/api/3/issue", method="POST", body=create_body)
                issue_key = create_res.get("key", "UNKNOWN")
                self._last_issue_key = issue_key
                return Data(data={
                    "status": "created",
                    "action": "ticket_created",
                    "issue_key": issue_key,
                    "occurrence_count": 1,
                    "fingerprint": fingerprint,
                    "request_id": request_id
                })
            except Exception as e:
                return Data(data={
                    "status": "error",
                    "stage": "create",
                    "fingerprint": fingerprint,
                    "error_detail": str(e)
                })

    def get_issue_key(self) -> str:
        return getattr(self, "_last_issue_key", "UNKNOWN")
