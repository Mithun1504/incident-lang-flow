import urllib.parse
from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data
from lifecycle_api import LifecycleAPI


class OpenPullRequest(LifecycleAPI, Component):
    display_name = 'Open or Reuse Pull Request'
    description = 'Creates a PR from the developer branch into main, or reuses the matching open PR.'
    icon = 'git-pull-request'
    name = 'OpenPullRequest'
    inputs = [HandleInput(name='context', display_name='Verified Fix', input_types=['Data'], required=True)]
    outputs = [Output(display_name='Pull Request', name='result', method='process')]

    def process(self) -> Data:
        context = self._data(self.context)
        if not context.get('eligible') or not context.get('branch_verified'):
            self.status = 'No PR action: ' + str(context.get('reason') or 'branch_not_verified')
            return Data(data=context)
        repo = self._repo_path(context)
        query = urllib.parse.urlencode({'state': 'open', 'head': f'{context["owner"]}:{context["branch"]}', 'base': context['base_branch'], 'per_page': '10'})
        existing = self._github(f'{repo}/pulls?{query}')
        if existing:
            pr, action = existing[0], 'existing_pr'
        else:
            try:
                pr = self._github(f'{repo}/pulls', 'POST', {'title': f'Fix {context["issue_key"]}: {context.get("summary") or context["issue_key"]}'[:256],
                    'head': context['branch'], 'base': context['base_branch'], 'body': f'Fixes {context["issue_key"]}\n\nCreated from the developer\'s pushed fix branch by the Incident Lifecycle flow.', 'draft': False})
                action = 'created_pr'
            except RuntimeError as error:
                # A webhook and watcher may race. GitHub prevents duplicate PRs.
                if getattr(error, 'status_code', None) != 422:
                    raise
                matches = self._github(f'{repo}/pulls?{query}')
                if not matches:
                    raise
                pr, action = matches[0], 'existing_pr'
        if not pr.get('html_url'):
            raise ValueError('GitHub returned a PR without a URL')
        self.status = f'{action}: {pr["html_url"]}'
        return Data(data={**context, 'status': 'pr_ready', 'action': action, 'pr_url': pr['html_url'], 'pr_number': pr.get('number')})
