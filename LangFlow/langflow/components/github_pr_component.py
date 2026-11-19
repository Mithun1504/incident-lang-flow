import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from langflow.custom import Component
from langflow.io import MultilineInput, Output
from langflow.schema import Data


class JiraDoneToGitHubPRComponent(Component):
    """Create one GitHub PR for a manually pushed Jira fix branch.

    The repository is deliberately configured server-side for this prototype.
    The incoming Jira event can select the issue, but cannot select an arbitrary
    repository or target branch.
    """

    display_name = "Jira Done to GitHub PR"
    description = "Creates a GitHub PR from fix/<JIRA-KEY> after a Jira issue reaches Done."
    icon = "github"
    name = "JiraDoneToGitHubPR"

    inputs = [
        MultilineInput(
            name="data",
            display_name="Jira Webhook Payload",
            info="Raw JSON body injected by the LangFlow webhook endpoint.",
            advanced=True,
            input_types=[],
            required=False,
        )
    ]

    outputs = [
        Output(display_name="Result Data", name="result", method="process_event"),
        Output(display_name="Jira Issue Key", name="issue_key", method="get_issue_key"),
        Output(display_name="Pull Request URL", name="pr_url", method="get_pr_url"),
    ]

    def _jira_auth(self) -> str:
        raw = f"{os.environ.get('JIRA_EMAIL', '').strip()}:{os.environ.get('JIRA_API_TOKEN', '').strip()}"
        return "Basic " + base64.b64encode(raw.encode("utf-8")).decode("ascii")

    def _github_call(self, endpoint: str, method: str = "GET", body: Optional[dict] = None) -> Dict[str, Any] | list:
        token = os.environ.get("GITHUB_TOKEN", "").strip()
        if not token:
            raise ValueError("GITHUB_TOKEN is not configured")
        url = "https://api.github.com" + endpoint
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "langflow-jira-pr-prototype",
        }
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                text = response.read().decode("utf-8")
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace") if error.fp else ""
            raise RuntimeError(f"GitHub API error ({error.code}) {method} {endpoint}: {detail[:500]}") from error
        except Exception as error:
            raise RuntimeError(f"GitHub request failed {method} {endpoint}: {error}") from error

    def _jira_call(self, endpoint: str, method: str = "GET", body: Optional[dict] = None) -> Dict[str, Any] | list:
        base_url = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
        if not base_url or not os.environ.get("JIRA_EMAIL") or not os.environ.get("JIRA_API_TOKEN"):
            raise ValueError("Jira credentials are not configured")
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            f"{base_url}{endpoint}",
            data=payload,
            headers={
                "Authorization": self._jira_auth(),
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                text = response.read().decode("utf-8")
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace") if error.fp else ""
            raise RuntimeError(f"Jira API error ({error.code}) {method} {endpoint}: {detail[:500]}") from error
        except Exception as error:
            raise RuntimeError(f"Jira request failed {method} {endpoint}: {error}") from error

    @staticmethod
    def _payload_value(payload: dict, *keys: str) -> Any:
        for key in keys:
            if payload.get(key) is not None:
                return payload[key]
        return None

    def _parse_event(self) -> dict:
        raw = self.data
        if hasattr(raw, "data") and isinstance(raw.data, dict) and raw.data:
            return raw.data
        if hasattr(raw, "text"):
            raw = raw.text or getattr(raw, "default_value", "")
        if isinstance(raw, dict):
            return raw
        if not isinstance(raw, str) or not raw.strip():
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(f"Jira webhook payload is not valid JSON: {error}") from error

    def _issue_context(self, payload: dict) -> tuple[str, str, dict]:
        issue = payload.get("issue") if isinstance(payload.get("issue"), dict) else payload
        fields = issue.get("fields") if isinstance(issue.get("fields"), dict) else {}
        status = fields.get("status") if isinstance(fields.get("status"), dict) else {}
        issue_key = str(self._payload_value(issue, "key", "issue_key") or payload.get("issue_key") or "").strip()
        status_name = str(
            self._payload_value(status, "name")
            or self._payload_value(payload, "status", "status_name")
            or ""
        ).strip()
        return issue_key, status_name, issue

    def _comment_jira(self, issue_key: str, text: str) -> None:
        body = {
            "body": {
                "type": "doc",
                "version": 1,
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}],
            }
        }
        self._jira_call(f"/rest/api/3/issue/{urllib.parse.quote(issue_key)}/comment", "POST", body)

    def _transition_jira(self, issue_key: str, target_status: str) -> str:
        transitions = self._jira_call(
            f"/rest/api/3/issue/{urllib.parse.quote(issue_key)}/transitions", "GET"
        )
        for transition in transitions.get("transitions", []) if isinstance(transitions, dict) else []:
            to = transition.get("to") or {}
            if str(to.get("name", "")).casefold() == target_status.casefold():
                self._jira_call(
                    f"/rest/api/3/issue/{urllib.parse.quote(issue_key)}/transitions",
                    "POST",
                    {"transition": {"id": transition["id"]}},
                )
                return str(to.get("name") or target_status)
        return ""

    def process_event(self) -> Data:
        self._last_issue_key = ""
        self._last_pr_url = ""
        payload = self._parse_event()
        issue_key, status_name, issue = self._issue_context(payload)
        self._last_issue_key = issue_key
        trigger_status = os.environ.get("JIRA_PR_TRIGGER_STATUS", "Done").strip() or "Done"

        if not issue_key:
            return Data(data={"status": "error", "error": "Jira issue key is missing"})
        if status_name.casefold() != trigger_status.casefold():
            return Data(data={"status": "ignored", "reason": f"status is {status_name or 'unknown'}", "issue_key": issue_key})

        owner = os.environ.get("GITHUB_OWNER", "anuraag-bagepalli").strip()
        repository = os.environ.get("GITHUB_REPOSITORY", "incident-demo-app").strip()
        base_branch = os.environ.get("GITHUB_BASE_BRANCH", "main").strip() or "main"
        branch = f"fix/{issue_key}"
        encoded_repo = f"{urllib.parse.quote(owner)}/{urllib.parse.quote(repository)}"

        try:
            self._github_call(f"/repos/{encoded_repo}/branches/{urllib.parse.quote(branch, safe='')}")
        except RuntimeError as error:
            message = f"Branch {branch} is not available in {owner}/{repository}. Push it before marking the ticket Done."
            try:
                self._comment_jira(issue_key, message)
            except Exception:
                pass
            return Data(data={"status": "blocked", "reason": "missing_branch", "issue_key": issue_key, "branch": branch, "error": str(error)})

        query = urllib.parse.urlencode({"state": "open", "head": f"{owner}:{branch}", "base": base_branch, "per_page": "10"})
        existing = self._github_call(f"/repos/{encoded_repo}/pulls?{query}", "GET")
        prs = existing if isinstance(existing, list) else []
        if prs:
            pr_url = str(prs[0].get("html_url") or "")
            action = "existing_pr"
        else:
            summary = ((issue.get("fields") or {}).get("summary") or f"Fix {issue_key}").strip()
            created = self._github_call(
                f"/repos/{encoded_repo}/pulls",
                "POST",
                {
                    "title": f"Fix {issue_key}: {summary}",
                    "head": branch,
                    "base": base_branch,
                    "body": f"Fixes {issue_key}\n\nCreated from the developer's pushed branch.",
                    "draft": False,
                },
            )
            pr_url = str(created.get("html_url") or "")
            action = "created_pr"

        self._last_pr_url = pr_url
        try:
            self._comment_jira(issue_key, f"GitHub PR ({action}): {pr_url}")
        except Exception as error:
            return Data(data={"status": "partial", "action": action, "issue_key": issue_key, "pr_url": pr_url, "error": str(error)})

        raised_status = os.environ.get("JIRA_PR_RAISED_STATUS", "PR Raised").strip() or "PR Raised"
        transitioned_to = self._transition_jira(issue_key, raised_status)
        return Data(data={"status": "success", "action": action, "issue_key": issue_key, "branch": branch, "pr_url": pr_url, "jira_status": transitioned_to or raised_status})

    def get_issue_key(self) -> str:
        return getattr(self, "_last_issue_key", "")

    def get_pr_url(self) -> str:
        return getattr(self, "_last_pr_url", "")
