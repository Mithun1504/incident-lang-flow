import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data


class CreateGitHubPR(Component):
    display_name = "Create GitHub PR"
    description = "Checks the developer branch, creates one PR, comments Jira, and transitions the ticket."
    icon = "github"
    name = "CreateGitHubPR"

    inputs = [HandleInput(name="context", display_name="PR Context", input_types=["Data", "JSON", "Message"], required=False)]
    outputs = [Output(display_name="PR Result", name="result", method="process")]

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

    def _github(self, endpoint: str, method: str = "GET", body: Optional[dict] = None) -> Any:
        token = os.environ.get("GITHUB_TOKEN", "").strip()
        if not token:
            raise ValueError("GITHUB_TOKEN is not configured")
        payload = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            "https://api.github.com" + endpoint,
            data=payload,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                text = response.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace") if error.fp else ""
            raise RuntimeError(f"GitHub API error ({error.code}): {detail[:500]}") from error

    def _jira(self, endpoint: str, method: str = "GET", body: Optional[dict] = None) -> Any:
        base = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
        email = os.environ.get("JIRA_EMAIL", "").strip()
        token = os.environ.get("JIRA_API_TOKEN", "").strip()
        raw = base64.b64encode(f"{email}:{token}".encode()).decode()
        payload = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(f"{base}{endpoint}", data=payload, headers={"Authorization": f"Basic {raw}", "Accept": "application/json", "Content-Type": "application/json"}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                text = response.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace") if error.fp else ""
            raise RuntimeError(f"Jira API error ({error.code}): {detail[:500]}") from error

    def process(self) -> Data:
        context = self._dict(self.context)
        if not context.get("eligible"):
            return Data(data={**context, "status": "ignored", "reason": context.get("validation", "status_not_done")})
        key = str(context.get("issue_key") or "")
        owner = str(context.get("owner") or "")
        repo = str(context.get("repository") or "")
        branch = str(context.get("branch") or f"fix/{key}")
        base_branch = str(context.get("base_branch") or "main")
        repo_path = f"{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}"
        encoded_branch = urllib.parse.quote(branch, safe="")
        try:
            self._github(f"/repos/{repo_path}/branches/{encoded_branch}")
        except Exception as error:
            message = f"Branch {branch} is not available in {owner}/{repo}. Push it before marking {key} Done."
            try:
                self._jira(f"/rest/api/3/issue/{urllib.parse.quote(key)}/comment", "POST", {"body": {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [{"type": "text", "text": message}]}]}})
            except Exception:
                pass
            return Data(data={**context, "status": "blocked", "reason": "missing_branch", "error": str(error)})
        query = urllib.parse.urlencode({"state": "open", "head": f"{owner}:{branch}", "base": base_branch, "per_page": "10"})
        existing = self._github(f"/repos/{repo_path}/pulls?{query}")
        prs = existing if isinstance(existing, list) else []
        if prs:
            pr_url, action = str(prs[0].get("html_url") or ""), "existing_pr"
        else:
            created = self._github(f"/repos/{repo_path}/pulls", "POST", {"title": f"Fix {key}: {context.get('summary') or key}", "head": branch, "base": base_branch, "body": f"Fixes {key}\n\nCreated from the developer's pushed branch.", "draft": False})
            pr_url, action = str(created.get("html_url") or ""), "created_pr"
        self._jira(f"/rest/api/3/issue/{urllib.parse.quote(key)}/comment", "POST", {"body": {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [{"type": "text", "text": f"GitHub PR ({action}): {pr_url}"}]}]}})
        target = os.environ.get("JIRA_PR_RAISED_STATUS", "PR Raised").strip() or "PR Raised"
        transitions = self._jira(f"/rest/api/3/issue/{urllib.parse.quote(key)}/transitions")
        transitioned = ""
        for transition in transitions.get("transitions", []) if isinstance(transitions, dict) else []:
            if str((transition.get("to") or {}).get("name", "")).casefold() == target.casefold():
                self._jira(f"/rest/api/3/issue/{urllib.parse.quote(key)}/transitions", "POST", {"transition": {"id": transition["id"]}})
                transitioned = target
                break
        return Data(data={**context, "status": "success", "action": action, "pr_url": pr_url, "jira_status": transitioned or target})
