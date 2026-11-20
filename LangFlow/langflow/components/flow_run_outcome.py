from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data
from lifecycle_api import LifecycleAPI


class LifecycleOutcome(LifecycleAPI, Component):
    display_name = 'Run Outcome'
    description = 'A concise, inspectable result for this lifecycle event.'
    icon = 'circle-check'
    name = 'LifecycleOutcome'
    inputs = [HandleInput(name='input_data', display_name='Stage Result', input_types=['Data'], required=True)]
    outputs = [Output(display_name='Result', name='result', method='process')]

    def process(self) -> Data:
        event = self._data(self.input_data)
        fields = ('event_type', 'status', 'action', 'reason', 'issue_key', 'issue_url', 'pr_url', 'pr_number', 'jira_status',
                  'lifecycle_stage', 'expected_branch', 'resume_status', 'request_id', 'event_id', 'warning', 'occurrence_count')
        result = {key: event[key] for key in fields if key in event}
        result.setdefault('status', 'ignored')
        if event.get('route_reason'):
            result.setdefault('reason', event['route_reason'])
        self.status = result
        return Data(data=result)
