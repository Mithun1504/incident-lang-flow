import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from test_flows import Data, INCIDENT, load, ROOT
sys.path.insert(0, str(ROOT))
Router = load('flow_event_router', 'LifecycleEventRouter')
Handoff = load('flow_await_developer', 'AwaitDeveloper')
Verify = load('flow_verify_branch', 'VerifyFixBranch')
Open = load('flow_open_pr', 'OpenPullRequest')
Link = load('flow_link_jira', 'LinkPullRequestToJira')
Outcome = load('flow_run_outcome', 'LifecycleOutcome')

class RouterTests(unittest.TestCase):
    def router(self, payload):
        node = Router(); node.input_data = Data(payload); node.stopped = []
        node.stop = node.stopped.append
        node.excluded = []; node._id = 'router'
        node.graph = SimpleNamespace(exclude_branch_conditionally=lambda node_id, output_name: node.excluded.append(output_name))
        return node

    def test_error_activates_only_incident_lane(self):
        node = self.router(INCIDENT)
        self.assertEqual(node.incident_event().data['route'], '/api/fail-two')
        self.assertEqual(set(node.excluded), {'jira', 'ignored'})
        self.assertEqual(node.jira_event().data, {})

    def test_wrapped_jira_activates_only_pr_lane(self):
        node = self.router({'payload': json.dumps({'issue': {'key': 'SUP-3', 'fields': {'status': {'name': 'Completed'}}}})})
        self.assertEqual(node.jira_event().data['issue']['key'], 'SUP-3')
        self.assertEqual(set(node.excluded), {'incident', 'ignored'})

    def test_success_and_empty_events_have_no_external_lane(self):
        for payload in ({**INCIDENT, 'level': 'info'}, {}, {'event_type': 'preview'}):
            node = self.router(payload)
            self.assertEqual(node.ignored_event().data['event_type'], 'ignored')
            self.assertEqual(set(node.excluded), {'incident', 'jira'})

    def test_ambiguous_event_is_rejected(self):
        with self.assertRaises(ValueError): self.router({**INCIDENT, 'issue': {'key': 'SUP-3'}}).incident_event()

    def test_invalid_transport_fails_before_side_effects(self):
        with self.assertRaises(ValueError): self.router({'payload': '{invalid'}).incident_event()

    def test_handoff_is_a_record_not_a_background_wait(self):
        node = Handoff(); node.ticket = Data({'issue_key': 'SUP-3', 'status': 'created'})
        node.branch_prefix = 'fix/'; node.trigger_status = 'Completed'
        self.assertEqual(node.process().data['expected_branch'], 'fix/SUP-3')
        self.assertEqual(node.process().data['lifecycle_stage'], 'awaiting_developer')

class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'JIRA_PROJECT_KEY': 'SUP'}); self.env.start(); self.addCleanup(self.env.stop)
        self.context = dict(eligible=True, issue_key='SUP-3', owner='demo', repository='app', branch='fix/SUP-3', base_branch='main', trigger_status='Completed', summary='Example incident')

    def verify(self):
        node = Verify(); node.context = Data(self.context)
        node._jira = lambda *args: {'fields': {'status': {'name': 'Completed'}, 'labels': ['automated-incident']}}
        node._github = lambda endpoint, *args: {'ahead_by': 1} if '/compare/' in endpoint else {}
        node._comment_once = lambda *args, **kwargs: None
        return node

    def test_real_fix_branch_is_verified(self):
        self.assertTrue(self.verify().process().data['branch_verified'])

    def test_changed_status_never_reaches_github(self):
        node = self.verify(); node._jira = lambda *args: {'fields': {'status': {'name': 'Open'}}}
        node._github = lambda *args: self.fail('GitHub must not be called')
        self.assertEqual(node.process().data['reason'], 'jira_status_changed')

    def test_unrelated_project_is_rejected(self):
        node = self.verify(); node.context.data['issue_key'] = 'OTHER-1'
        with self.assertRaises(ValueError): node.process()

    def test_branch_without_commits_is_blocked(self):
        node = self.verify(); node._github = lambda *args: {'ahead_by': 0}
        self.assertEqual(node.process().data['reason'], 'no_commits')

    def test_missing_branch_and_auth_error_are_distinct(self):
        node = self.verify()
        def fail404(*args):
            error = RuntimeError('Missing'); error.status_code = 404; raise error
        node._github = fail404
        self.assertEqual(node.process().data['reason'], 'missing_branch')
        def fail403(*args):
            error = RuntimeError('Forbidden'); error.status_code = 403; raise error
        node._github = fail403
        with self.assertRaises(RuntimeError): node.process()

    def test_pr_created_once_or_reused(self):
        for existing in (False, True):
            node = Open(); node.context = Data({**self.context, 'branch_verified': True}); calls = []
            def github(endpoint, method='GET', body=None):
                calls.append(method)
                return ([{'html_url': 'https://github.com/demo/app/pull/1'}] if existing else []) if '/pulls?' in endpoint else {'html_url': 'https://github.com/demo/app/pull/1', 'number': 1}
            node._github = github
            result = node.process().data
            self.assertEqual(result['action'], 'existing_pr' if existing else 'created_pr')
            self.assertEqual(calls.count('POST'), 0 if existing else 1)

    def test_blocked_branch_has_no_pr_or_jira_side_effects(self):
        for cls in (Open, Link):
            node = cls(); node.context = Data({**self.context, 'status': 'blocked', 'reason': 'missing_branch'})
            node._github = node._jira = lambda *args: self.fail('No external calls expected')
            self.assertEqual(node.process().data['status'], 'blocked')

    def test_jira_link_preserves_actual_status_and_reports_unavailable_transition(self):
        for target in ('', 'PR Raised'):
            node = Link(); node.raised_status = target; node.context = Data({**self.context, 'pr_url': 'https://github.com/demo/app/pull/1', 'action': 'created_pr'})
            comments = []; node._comment_once = lambda *args, **kwargs: comments.append(args)
            node._jira = lambda endpoint, *args: {'transitions': []} if endpoint.endswith('/transitions') else {'fields': {'status': {'name': 'Completed'}}}
            result = node.process().data
            self.assertEqual(result['jira_status'], 'Completed')
            self.assertEqual(result['status'], 'partial' if target else 'success')
            self.assertEqual(len(comments), 1)

    def test_http_helpers_are_embedded_without_credentials(self):
        from lifecycle_api import LifecycleAPI
        node = LifecycleAPI(); calls = []
        def jira(endpoint, method='GET', body=None):
            calls.append(method)
            return {'comments': [{'body': {'text': 'existing URL'}}], 'total': 1}
        node._jira = jira
        node._comment_once('SUP-3', 'existing URL', marker='existing URL')
        self.assertEqual(calls, ['GET'])

if __name__ == '__main__': unittest.main()
