const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app } = require('../src/server');

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://localhost:${port}`;
});

test.after((_, done) => {
  server.close(done);
});

test('GET /api/health returns 200 with status ok and does not expose API key', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.status, 'ok');
  assert.equal(data.service, 'pm2-log-viewer');
  assert.equal(typeof data.totalLogs, 'number');
  assert.equal(typeof data.forwardEnabled, 'boolean');

  // Strict safety check: Never leak API key in health endpoint
  const rawText = JSON.stringify(data);
  assert.equal(rawText.includes('sk-'), false, 'API key must not be exposed in /api/health');
  assert.equal(data.langflowApiKey, undefined);
  assert.equal(data.apiKey, undefined);
});

test('GET /api/logs returns 200 and list of logs', async () => {
  const res = await fetch(`${baseUrl}/api/logs`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(typeof data.total, 'number');
  assert.ok(Array.isArray(data.logs));
});

test('GET /api/logs/:eventId returns 404 for unknown ID', async () => {
  const res = await fetch(`${baseUrl}/api/logs/non-existent-event-id`);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.ok(data.error);
});
