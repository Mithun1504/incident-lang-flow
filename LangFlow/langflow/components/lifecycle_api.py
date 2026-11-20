"""Shared HTTP and payload helpers embedded into lifecycle graph components.

The flow builder inlines this mixin, so imported flows have no local-file
runtime dependency. Credentials are always read inside the LangFlow server.
"""
import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class LifecycleAPI:
    @staticmethod
    def _data(value: Any) -> dict:
        if hasattr(value, 'data'):
            value = value.data
        if not isinstance(value, dict):
            raise ValueError('This stage requires structured lifecycle data')
        return dict(value)

    def _request(self, service: str, endpoint: str, method: str = 'GET', body=None):
        if service == 'GitHub':
            token = os.environ.get('GITHUB_TOKEN', '').strip()
            if not token:
                raise ValueError('GITHUB_TOKEN is not configured')
            base = 'https://api.github.com'
            headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
        else:
            base = os.environ.get('JIRA_BASE_URL', '').rstrip('/')
            email = os.environ.get('JIRA_EMAIL', '').strip()
            token = os.environ.get('JIRA_API_TOKEN', '').strip()
            if not base or not email or not token:
                raise ValueError('Jira credentials are not configured')
            auth = base64.b64encode(f'{email}:{token}'.encode()).decode()
            headers = {'Authorization': f'Basic {auth}', 'Accept': 'application/json'}
        headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(base + endpoint, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                text = response.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors='replace') if error.fp else ''
            failure = RuntimeError(f'{service} API error ({error.code}): {detail[:300]}')
            failure.status_code = error.code
            raise failure from error

    def _github(self, endpoint, method='GET', body=None):
        return self._request('GitHub', endpoint, method, body)

    def _jira(self, endpoint, method='GET', body=None):
        return self._request('Jira', endpoint, method, body)

    @staticmethod
    def _issue_path(key):
        return '/rest/api/3/issue/' + urllib.parse.quote(key, safe='')

    @staticmethod
    def _repo_path(context):
        return '/repos/' + urllib.parse.quote(context['owner'], safe='') + '/' + urllib.parse.quote(context['repository'], safe='')

    def _comment_once(self, key, text, marker=None):
        """Look through paginated comments so event retries do not spam Jira."""
        start = 0
        while True:
            page = self._jira(f'{self._issue_path(key)}/comment?startAt={start}&maxResults=100')
            comments = page.get('comments') or []
            if (marker or text) in json.dumps([comment.get('body') for comment in comments]):
                return
            start += len(comments)
            if not comments or start >= page.get('total', start):
                break
        self._jira(f'{self._issue_path(key)}/comment', 'POST', {'body': {'type': 'doc', 'version': 1, 'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': text}]}]}})
