from langflow.custom import Component
from langflow.io import HandleInput, Output, StrInput
from langflow.schema import Data
from lifecycle_api import LifecycleAPI


class LinkPullRequestToJira(LifecycleAPI, Component):
    display_name = 'Link PR to Jira'
    description = 'Posts the PR URL once and applies an optional, available Jira transition.'
    icon = 'link'
    name = 'LinkPullRequestToJira'
    inputs = [HandleInput(name='context', display_name='Pull Request Result', input_types=['Data'], required=True),
              StrInput(name='raised_status', display_name='Optional Status After PR', value='')]
    outputs = [Output(display_name='Lifecycle Result', name='result', method='process')]

    def process(self) -> Data:
        context = self._data(self.context)
        if not context.get('pr_url'):
            self.status = 'No Jira update: ' + str(context.get('reason') or 'no_pr')
            return Data(data=context)
        key, url = context['issue_key'], context['pr_url']
        self._comment_once(key, f'GitHub PR ({context["action"]}): {url}', marker=url)
        live = self._jira(f'{self._issue_path(key)}?fields=status')
        status = ((live.get('fields') or {}).get('status') or {}).get('name', '')
        target = str(self.raised_status or '').strip()
        result = {**context, 'status': 'success', 'jira_status': status, 'lifecycle_stage': 'pr_linked'}
        if target and target.casefold() != status.casefold():
            transitions = self._jira(f'{self._issue_path(key)}/transitions')
            match = next((t for t in transitions.get('transitions', []) if str((t.get('to') or {}).get('name', '')).casefold() == target.casefold()), None)
            if match:
                self._jira(f'{self._issue_path(key)}/transitions', 'POST', {'transition': {'id': match['id']}})
                result['jira_status'] = target
            else:
                result.update(status='partial', warning=f'PR linked; transition to {target} is unavailable')
        self.status = f'{key} linked to {url}; Jira status: {result["jira_status"]}.'
        return Data(data=result)
