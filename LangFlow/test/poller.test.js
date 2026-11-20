const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-watcher-test-'));
process.env.JIRA_PR_POLLER_STATE_FILE = path.join(temporary, 'state.json');
process.env.GITHUB_OWNER = 'example';
process.env.GITHUB_REPOSITORY = 'demo';
process.env.GITHUB_TOKEN = 'test-token';
const { fixReadiness, retryDue, retryDelay, pollOnce } = require('../scripts/jira_pr_poller.cjs');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('missing branch and unchanged branch are not ready; pushed commits are ready', async t => {
  let response = { status: 404 };
  t.mock.method(global, 'fetch', async () => response);
  assert.equal((await fixReadiness('SUP-4')).ready, false);
  response = { ok: true, json: async () => ({ ahead_by: 0 }) };
  assert.equal((await fixReadiness('SUP-4')).reason, 'no_commits');
  response = { ok: true, json: async () => ({ ahead_by: 2, head_commit: { sha: 'new-commit' } }) };
  assert.equal((await fixReadiness('SUP-4')).sha, 'new-commit');
});
test('GitHub authentication failures remain errors, not missing branches', async t => {
  t.mock.method(global, 'fetch', async () => ({ status: 403, ok: false }));
  await assert.rejects(fixReadiness('SUP-4'), /HTTP 403/);
});
test('pending runs back off; new commits or Jira updates can run immediately', () => {
  const previous = { revision: 'jira:sha1', nextAttemptAt: new Date(120000).toISOString() };
  assert.equal(retryDue(previous, 'jira:sha1', 100000), false);
  assert.equal(retryDue(previous, 'jira:sha2', 100000), true);
  assert.equal(retryDue(previous, 'jira:sha1', 120001), true);
  assert.deepEqual([1,2,3,4,20].map(retryDelay), [60000,120000,240000,300000,300000]);
});
test('repeated completed-ticket polls without a fix never POST to LangFlow', async t => {
  let posts = 0;
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    if (options.method === 'POST') { posts++; throw Error('Unexpected graph execution'); }
    if (String(url).includes('api.github.com')) return { status: 404 };
    return { ok: true, text: async () => JSON.stringify({ isLast: true, issues: [{ key: 'SUP-4', fields: { updated: 'unchanged', comment: { comments: [] } } }] }) };
  });
  await pollOnce();
  await pollOnce();
  assert.equal(posts, 0);
  assert.equal(JSON.parse(fs.readFileSync(process.env.JIRA_PR_POLLER_STATE_FILE))['SUP-4'].status, 'waiting_for_fix');
});
