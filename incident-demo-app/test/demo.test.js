const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const serverPath = fs.existsSync(path.join(__dirname, '../server.js')) ? '../server' : '../app/server';
const { app } = require(serverPath);
let server, baseUrl;
const logs = [];
test.before(async () => {
  test.mock.method(console, 'log', text => { try { logs.push({ stream: 'out', ...JSON.parse(text) }); } catch (_) {} });
  test.mock.method(console, 'error', text => { logs.push({ stream: 'error', ...JSON.parse(text) }); });
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

test('every workspace page and its API responds successfully', async () => {
  for (const page of ['dashboard', 'my-profile', 'projects', 'team', 'settings']) {
    const html = await fetch(`${baseUrl}/${page}`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Northstar/);
    const api = await fetch(`${baseUrl}/api/${page}`);
    assert.equal(api.status, 200);
    const data = await api.json();
    const logged = logs.filter(log => log.request_id === data.request_id);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].level, 'info');
    assert.equal(logged[0].stream, 'out');
    assert.equal(logged[0].method, 'GET');
    assert.equal(logged[0].status_code, 200);
    assert.ok(Number.isFinite(logged[0].duration_ms));
  }
});
test('failure action emits exactly one structured error with a stack and correlation ID', async () => {
  const response = await fetch(`${baseUrl}/api/simulate-failure`, { method: 'POST' });
  assert.equal(response.status, 503);
  const data = await response.json();
  const logged = logs.filter(log => log.request_id === data.request_id);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].level, 'error');
  assert.equal(logged[0].stream, 'error');
  assert.equal(logged[0].route, '/api/simulate-failure');
  assert.match(logged[0].stack_trace, /ServiceUnavailableError/);
});
test('profile edits and preferences produce successful API logs', async () => {
  const p = await fetch(`${baseUrl}/api/my-profile`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Maya Lawson', bio: 'Updated demo profile' }) });
  assert.equal(p.status, 200);
  assert.equal((await p.json()).profile.bio, 'Updated demo profile');
  const s = await fetch(`${baseUrl}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weeklyDigest: false }) });
  assert.equal(s.status, 200);
  assert.equal((await s.json()).settings.weeklyDigest, false);
});
test('invalid JSON is a logged client warning and not an incident', async () => {
  const response = await fetch(`${baseUrl}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(logs.find(log => log.request_id === data.request_id).level, 'warn');
});
