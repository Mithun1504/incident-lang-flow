const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeIncident,
  normalizeStackTrace,
  generateFingerprint,
  stripAnsi
} = require('../src/normalizer');

test('stripAnsi removes ANSI escape sequences', () => {
  const colored = '\u001b[31mRed Error\u001b[39m';
  assert.equal(stripAnsi(colored), 'Red Error');
});

test('normalizeStackTrace normalizes Windows backslash paths to forward slashes', () => {
  const winStack =
    'IntentionalPrototypeError: Test failure\n    at C:\\Users\\USER\\Desktop\\Ellipsonic-Projects\\LangFlow\\app\\server.js:60:20';
  const normalized = normalizeStackTrace(winStack);
  assert.match(normalized, /C:\/Users\/USER\/Desktop\/Ellipsonic-Projects\/LangFlow\/app\/server\.js:60:20/);
});

test('generateFingerprint creates a deterministic 16-character SHA-256 fingerprint', () => {
  const fp1 = generateFingerprint('button-demo', '/api/fail-one', 'IntentionalError', 'Message A');
  const fp2 = generateFingerprint('button-demo', '/api/fail-one', 'IntentionalError', 'Message A');
  const fp3 = generateFingerprint('button-demo', '/api/fail-two', 'OtherError', 'Message B');

  assert.equal(fp1.length, 16);
  assert.equal(fp1, fp2);
  assert.notEqual(fp1, fp3);
});

test('normalizeIncident maps raw PM2 error entry into standard incident format', () => {
  const raw = {
    level: 'error',
    service: 'button-demo',
    environment: 'local',
    route: '/api/fail-one',
    error_type: 'IntentionalPrototypeError',
    message: 'Test failure from button one',
    stack_trace: 'IntentionalPrototypeError: Test failure\n    at C:\\app\\server.js:10:5',
    request_id: '57b795b4-f5ae-4486-a7f0-21d040cc9dde',
    timestamp: '2026-11-19T09:57:50.655Z'
  };

  const incident = normalizeIncident(raw);

  assert.equal(incident.source, 'pm2-log-viewer');
  assert.equal(incident.service, 'button-demo');
  assert.equal(incident.environment, 'local');
  assert.equal(incident.route, '/api/fail-one');
  assert.equal(incident.error_type, 'IntentionalPrototypeError');
  assert.equal(incident.message, 'Test failure from button one');
  assert.equal(incident.request_id, '57b795b4-f5ae-4486-a7f0-21d040cc9dde');
  assert.equal(incident.timestamp, '2026-11-19T09:57:50.655Z');
  assert.match(incident.stack_trace, /C:\/app\/server\.js:10:5/);
  assert.ok(incident.event_id.startsWith('evt_'));
  assert.ok(incident.fingerprint);
  assert.equal(incident.log_reference, 'pm2:button-demo:57b795b4-f5ae-4486-a7f0-21d040cc9dde');

  // Verify that it produces valid JSON string without error
  const jsonStr = JSON.stringify(incident);
  const reParsed = JSON.parse(jsonStr);
  assert.equal(reParsed.event_id, incident.event_id);
});

test('successful request metadata is retained without an incident fingerprint', () => {
  const raw = { level: 'info', service: 'button-demo', route: '/api/my-profile', method: 'GET', status_code: 200, duration_ms: 2.14, message: 'Profile loaded', request_id: 'success-1', timestamp: '2026-11-20T10:00:00.000Z' };
  const first = normalizeIncident(raw);
  assert.equal(first.level, 'info');
  assert.equal(first.status_code, 200);
  assert.equal(first.method, 'GET');
  assert.equal(first.duration_ms, 2.14);
  assert.equal(first.error_type, null);
  assert.equal(first.fingerprint, null);
  assert.equal(first.event_id, normalizeIncident(raw).event_id, 'event identity survives history reload');
});
