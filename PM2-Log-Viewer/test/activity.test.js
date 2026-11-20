const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const demoPath = path.resolve(__dirname, '../../LangFlow/app/server.js');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Real app -> two physical log files -> independent viewer -> mock webhook.
test('five successful page requests remain visible while only the failure reaches the webhook', { skip: !fs.existsSync(demoPath), timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-activity-'));
  const out = path.join(dir, 'out.log'), errors = path.join(dir, 'error.log');
  fs.writeFileSync(out, ''); fs.writeFileSync(errors, '');
  const { app } = require(demoPath);
  t.mock.method(console, 'log', text => { if (text.startsWith('{')) fs.appendFileSync(out, text + '\n'); });
  t.mock.method(console, 'error', text => fs.appendFileSync(errors, text + '\n'));
  const appServer = http.createServer(app);
  const demoPort = await listen(appServer);
  const received = [];
  const webhook = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(202); res.end('{}'); });
  });
  const hookPort = await listen(webhook);
  const reserve = http.createServer(); const port = await listen(reserve); await close(reserve);
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server.js')], {
    env: { ...process.env, PORT: String(port), PM2_LOG_SOURCE: errors, PM2_OUT_LOG_SOURCE: out,
      LOG_STATE_FILE: path.join(dir, 'error-state.json'), OUT_LOG_STATE_FILE: path.join(dir, 'out-state.json'),
      OUTBOX_FILE: path.join(dir, 'outbox.json'), FORWARD_ENABLED: 'true', POLL_INTERVAL_MS: '50',
      LANGFLOW_WEBHOOK_URL: `http://127.0.0.1:${hookPort}/webhook`, LANGFLOW_API_KEY: 'test-only', MAX_RETRIES: '1' },
    stdio: 'ignore'
  });
  t.after(async () => {
    child.kill('SIGTERM'); await close(appServer); await close(webhook);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  async function eventually(check) {
    for (let i = 0; i < 80; i++) { try { const result = await check(); if (result) return result; } catch (_) {} await sleep(50); }
    throw new Error('Timed out waiting for activity pipeline');
  }
  await eventually(async () => (await fetch(base + '/api/health')).ok);
  for (const page of ['dashboard', 'my-profile', 'projects', 'team', 'settings']) {
    const response = await fetch(`http://127.0.0.1:${demoPort}/api/${page}`); assert.equal(response.status, 200); await response.json();
  }
  await eventually(async () => (await (await fetch(base + '/api/logs')).json()).logs.length === 5);
  assert.equal(received.length, 0, 'successes never reach the webhook');
  await fetch(`http://127.0.0.1:${demoPort}/api/simulate-failure`, { method: 'POST' });
  const logs = await eventually(async () => {
    const data = await (await fetch(base + '/api/logs')).json();
    return data.logs.length === 6 && data.logs.some(log => log.deliveryStatus === 'forwarded') && data.logs;
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].level, 'error'); assert.equal(received[0].status_code, 503);
  assert.equal(received[0].route, '/api/simulate-failure');
  assert.equal(logs.filter(log => log.level === 'info').length, 5);
  const success = logs.find(log => log.level === 'info');
  assert.equal((await fetch(base + '/api/retry/' + success.event_id, { method: 'POST' })).status, 400);
  assert.equal(received.length, 1);
});
