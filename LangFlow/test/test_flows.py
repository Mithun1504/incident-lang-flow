"""Flow contract regressions; HTTP boundaries are mocked, no credentials needed."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

# Components have no dependency on a running LangFlow server for these tests.
class Component:
    pass

class Data:
    def __init__(self, data):
        self.data = data

for name in ('langflow', 'langflow.custom', 'langflow.io', 'langflow.schema'):
    sys.modules[name] = ModuleType(name)
sys.modules['langflow.custom'].Component = Component
sys.modules['langflow.schema'].Data = Data
for name in ('HandleInput', 'Output', 'StrInput'):
    setattr(sys.modules['langflow.io'], name, lambda **kwargs: kwargs)

ROOT = Path(__file__).resolve().parents[1] / 'langflow' / 'components'
def load(filename, classname):
    spec = importlib.util.spec_from_file_location(filename, ROOT / (filename + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, classname)

Normalize = load('flow_normalize_incident', 'NormalizeIncident')
Parse = load('flow_parse_jira_event', 'ParseJiraEvent')
Validate = load('flow_validate_jira_done', 'ValidateJiraDone')
Prepare = load('flow_prepare_pr', 'PreparePRContext')
Ticket = load('flow_jira_ticket', 'JiraTicketWriter')
PR = load('flow_create_pr', 'CreateGitHubPR')

INCIDENT = dict(service='button-demo', environment='local', route='/api/fail-two',
                error_type='IntentionalPrototypeError', message='Database timeout',
                request_id='req-1', stack_trace='Error\n    at C:/app/server.js:10',
                fingerprint='ccb50cd053c62ba2')

class ParsingTests(unittest.TestCase):
    def test_incident_transport_variants_keep_telemetry(self):
        encoded = json.dumps(INCIDENT)
        for value in (INCIDENT, Data(INCIDENT), {'data': {'payload': encoded}},
                      {'payload': encoded.replace('\\n', '\n')},
                      SimpleNamespace(data={}, text=encoded),
                      'Webhook received: ' + encoded):
            with self.subTest(value=type(value).__name__):
                node = Normalize(); node.input_data = value
                result = node.process().data
                for key in ('route', 'error_type', 'message', 'stack_trace', 'fingerprint'):
                    self.assertEqual(result[key], INCIDENT[key])

    def test_malformed_incidents_never_create_placeholder_tickets(self):
        for value in ({}, {'payload': 'not-json'}, {'message': 'incomplete'}, []):
            with self.subTest(value=value), self.assertRaises(ValueError):
                node = Normalize(); node.input_data = value; node.process()

    def test_wrapped_jira_event_and_configured_status(self):
        event = {'issue': {'key': 'SUP-3', 'fields': {'status': {'name': 'Completed'}, 'summary': 'A fix'}}}
        node = Parse(); node.input_data = Data({'payload': json.dumps(event)})
        parsed = node.process().data
        self.assertEqual(parsed['issue_key'], 'SUP-3')
        validator = Validate(); validator.event = Data(parsed); validator.trigger_status = 'Completed'
        self.assertTrue(validator.process().data['eligible'])
        validator.trigger_status = 'Done'
        self.assertFalse(validator.process().data['eligible'])

    def test_branch_prefix(self):
        node = Prepare(); node.event = Data({'issue_key': 'SUP-3'}); node.branch_prefix = 'feature/'
        self.assertEqual(node.process().data['branch'], 'feature/SUP-3')

class TicketTests(unittest.TestCase):
    @patch.dict(os.environ, {'JIRA_PROJECT_KEY': 'SUP'})
    def test_readable_title_and_project_scoped_lookup(self):
        calls = []
        def call(endpoint, method='GET', body=None):
            calls.append((endpoint, method, body))
            return {'issues': []} if endpoint.endswith('jql') else {'key': 'SUP-3'}
        node = Ticket(); node.incident = Data(INCIDENT); node._call = call
        self.assertEqual(node.process().data['issue_key'], 'SUP-3')
        self.assertIn('project = "SUP"', calls[0][2]['jql'])
        self.assertEqual(calls[1][2]['fields']['summary'], 'button-demo (local): IntentionalPrototypeError on /api/fail-two')

    def test_writer_rejects_missing_fields(self):
        node = Ticket(); node.incident = Data({})
        with self.assertRaises(ValueError): node.process()

    def test_recurrence_updates_existing_title(self):
        calls = []
        def call(endpoint, method='GET', body=None):
            calls.append((endpoint, method, body))
            return {'issues': [{'key': 'SUP-3', 'fields': {'comment': {'comments': []}}}]} if endpoint.endswith('jql') else {}
        node = Ticket(); node.incident = Data(INCIDENT); node._call = call
        self.assertEqual(node.process().data['action'], 'duplicate_updated')
        self.assertIn('summary', calls[-1][2]['fields'])

    def test_pr_comments_do_not_inflate_occurrence_count(self):
        calls = []
        description = Ticket._description({**INCIDENT, 'request_id': 'previous'}, 2)
        def call(endpoint, method='GET', body=None):
            calls.append((endpoint, method, body))
            return {'issues': [{'key': 'SUP-3', 'fields': {'description': description, 'comment': {'comments': [{}] * 10}}}]} if endpoint.endswith('jql') else {}
        node = Ticket(); node.incident = Data(INCIDENT); node._call = call
        self.assertEqual(node.process().data['occurrence_count'], 3)

    def test_same_request_retry_does_not_count_twice(self):
        description = Ticket._description(INCIDENT, 2)
        node = Ticket(); node.incident = Data(INCIDENT)
        node._call = lambda *args: {'issues': [{'key': 'SUP-3', 'fields': {'description': description}}]}
        self.assertEqual(node.process().data['action'], 'already_processed')

class PRTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'JIRA_PROJECT_KEY': 'SUP'}); self.env.start(); self.addCleanup(self.env.stop)
        self.node = PR(); self.node.raised_status = ''
        self.node.context = Data(dict(eligible=True, issue_key='SUP-3', owner='demo', repository='app', branch='fix/SUP-3', base_branch='main', trigger_status='Completed', summary='Fix failure'))
        self.calls = []
        self.live_status = 'Completed'; self.comment = {}; self.prs = []
        def jira(endpoint, method='GET', body=None):
            self.calls.append(('jira', endpoint, method, body))
            if '?fields=' in endpoint: return {'fields': {'status': {'name': self.live_status}, 'comment': self.comment}}
            if endpoint.endswith('/transitions'): return {'transitions': []}
            return {}
        def github(endpoint, method='GET', body=None):
            self.calls.append(('github', endpoint, method, body))
            if '/pulls?' in endpoint: return self.prs
            if endpoint.endswith('/pulls'): return {'html_url': 'https://github.com/demo/app/pull/1'}
            return {}
        self.node._jira = jira; self.node._github = github

    def test_creates_pr_and_keeps_actual_completed_status(self):
        result = self.node.process().data
        self.assertEqual(result['action'], 'created_pr')
        self.assertEqual(result['jira_status'], 'Completed')
        self.assertEqual(sum(c[0]=='github' and c[2]=='POST' for c in self.calls), 1)

    def test_reuses_open_pr_without_duplicate_comment(self):
        self.prs = [{'html_url': 'https://github.com/demo/app/pull/1'}]
        self.comment = {'text': 'GitHub PR (created_pr): https://github.com/demo/app/pull/1'}
        self.assertEqual(self.node.process().data['action'], 'existing_pr')
        self.assertFalse(any(c[2]=='POST' for c in self.calls))

    def test_changed_status_does_not_create_pr(self):
        self.live_status = 'Open'
        self.assertEqual(self.node.process().data['reason'], 'jira_status_changed')
        self.assertFalse(any(c[0]=='github' for c in self.calls))

    def test_missing_branch_is_blocked(self):
        def missing(*args):
            error = RuntimeError('Not Found'); error.status_code = 404; raise error
        self.node._github = missing
        self.assertEqual(self.node.process().data['reason'], 'missing_branch')

    def test_auth_error_is_not_reported_as_missing_branch(self):
        def forbidden(*args):
            error = RuntimeError('Forbidden'); error.status_code = 403; raise error
        self.node._github = forbidden
        with self.assertRaises(RuntimeError): self.node.process()

    def test_unavailable_transition_does_not_claim_pr_raised(self):
        self.node.raised_status = 'PR Raised'
        result = self.node.process().data
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['jira_status'], 'Completed')

    def test_other_project_cannot_create_pr(self):
        self.node.context.data['issue_key'] = 'OTHER-1'
        with self.assertRaises(ValueError): self.node.process()

if __name__ == '__main__': unittest.main()
