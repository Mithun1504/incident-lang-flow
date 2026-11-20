import os
from langflow.custom import Component
from langflow.io import HandleInput, Output, StrInput
from langflow.schema import Data
from lifecycle_api import LifecycleAPI


class AwaitDeveloper(LifecycleAPI, Component):
    display_name = 'Developer Handoff'
    description = 'Records the ticket handoff. The next Jira event resumes this lifecycle in the same flow.'
    icon = 'user-check'
    name = 'AwaitDeveloper'
    inputs = [
        HandleInput(name='ticket', display_name='Jira Ticket', input_types=['Data'], required=True),
        StrInput(name='branch_prefix', display_name='Branch Prefix', value='fix/'),
        StrInput(name='trigger_status', display_name='Resolved Status', value='Done'),
    ]
    outputs = [Output(display_name='Handoff Recorded', name='result', method='process')]

    def process(self) -> Data:
        ticket = self._data(self.ticket)
        key = ticket.get('issue_key')
        if not key:
            raise ValueError('Jira did not return an issue key')
        branch = f'{self.branch_prefix}{key}'
        self.status = f'{key} ready. Push {branch}, then resolve to {self.trigger_status}.'
        return Data(data={**ticket, 'lifecycle_stage': 'awaiting_developer', 'expected_branch': branch,
                          'resume_status': self.trigger_status, 'issue_url': os.environ.get('JIRA_BASE_URL', '').rstrip('/') + '/browse/' + key})
