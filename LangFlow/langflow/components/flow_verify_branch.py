import os
import re
import urllib.parse
from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data
from lifecycle_api import LifecycleAPI


class VerifyFixBranch(LifecycleAPI, Component):
    display_name = 'Verify Fix Branch'
    description = 'Rechecks Jira status, repository branch, and commits ahead of the base branch.'
    icon = 'git-branch'
    name = 'VerifyFixBranch'
    inputs = [HandleInput(name='context', display_name='Fix Context', input_types=['Data'], required=True)]
    outputs = [Output(display_name='Verified Branch', name='result', method='process')]

    def process(self) -> Data:
        context = self._data(self.context)
        if not context.get('eligible'):
            self.status = 'Skipped: Jira is not in the configured resolved status.'
            return Data(data={**context, 'status': 'ignored', 'reason': 'status_not_resolved'})
        key = str(context.get('issue_key') or '')
        project = os.environ.get('JIRA_PROJECT_KEY', 'DEMO').strip()
        if not re.fullmatch(re.escape(project) + r'-\d+', key):
            raise ValueError('Issue does not belong to the configured Jira project')
        live = self._jira(f'{self._issue_path(key)}?fields=status,labels')
        fields = live.get('fields') or {}
        status = (fields.get('status') or {}).get('name', '')
        if status.casefold() != str(context.get('trigger_status') or 'Done').casefold():
            self.status = f'Ignored stale event: live Jira status is {status}.'
            return Data(data={**context, 'status': 'ignored', 'reason': 'jira_status_changed', 'eligible': False, 'jira_status': status})
        if 'automated-incident' not in (fields.get('labels') or []):
            raise ValueError('Only automated incident tickets may create a PR')
        repo = self._repo_path(context)
        branch = context['branch']
        try:
            self._github(f'{repo}/branches/{urllib.parse.quote(branch, safe="")}')
        except RuntimeError as error:
            if getattr(error, 'status_code', None) != 404:
                raise
            text = f'Branch {branch} is not available in {context["owner"]}/{context["repository"]}. Push the fix branch before resolving {key}.'
            self._comment_once(key, text)
            self.status = text
            return Data(data={**context, 'status': 'blocked', 'reason': 'missing_branch', 'branch_verified': False, 'jira_status': status})
        comparison = self._github(f'{repo}/compare/{urllib.parse.quote(context["base_branch"], safe="")}...{urllib.parse.quote(branch, safe="")}')
        if comparison.get('ahead_by', 0) < 1:
            text = f'Branch {branch} has no commits ahead of {context["base_branch"]}. Commit and push the actual fix to open a PR.'
            self._comment_once(key, text)
            self.status = text
            return Data(data={**context, 'status': 'blocked', 'reason': 'no_commits', 'branch_verified': False, 'jira_status': status})
        self.status = f'{branch} verified: {comparison["ahead_by"]} commit(s) ahead.'
        return Data(data={**context, 'branch_verified': True, 'jira_status': status, 'commits_ahead': comparison['ahead_by']})
