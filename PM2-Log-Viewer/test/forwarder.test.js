const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const IncidentForwarder = require('../src/forwarder');

const testDir = path.join(__dirname, 'tmp-fwd');

test.before(() => {
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
});

test.after(() => {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch (_) {}
});

test('IncidentForwarder dry-run mode does not call webhook and marks status dry-run', async (t) => {
  const outboxFile = path.join(testDir, 'outbox-dry.json');

  const forwarder = new IncidentForwarder({
    langflowWebhookUrl: 'http://invalid-destination:9999/webhook',
    langflowApiKey: 'dummy-key',
    forwardEnabled: false,
    outboxFile
  });

  t.after(() => forwarder.stop());

  const incident = {
    event_id: 'evt_test_dry_1',
    message: 'Dry run test error'
  };

  const res = await forwarder.forward(incident);
  assert.equal(res.success, true);
  assert.equal(res.status, 'dry-run');
  assert.equal(forwarder.getStatus('evt_test_dry_1').status, 'dry-run');
  assert.equal(forwarder.outbox.count(), 0);
});

test('IncidentForwarder treats HTTP 202 as accepted', async (t) => {
  const outboxFile = path.join(testDir, 'outbox-202.json');

  let receivedHeaders = null;
  let receivedBody = null;

  // Spin up temporary mock server responding with 202 Accepted
  const server = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      receivedBody = JSON.parse(body);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'queued', message: 'Accepted' }));
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  t.after(() => {
    server.close();
  });

  const forwarder = new IncidentForwarder({
    langflowWebhookUrl: `http://localhost:${port}/webhook`,
    langflowApiKey: 'test-secret-key-123',
    forwardEnabled: true,
    outboxFile
  });

  t.after(() => forwarder.stop());

  const incident = {
    event_id: 'evt_202_accepted',
    message: 'Incident accepted test',
    error_type: 'TestError'
  };

  const res = await forwarder.forward(incident);
  assert.equal(res.success, true);
  assert.equal(res.status, 'forwarded');
  assert.equal(res.httpStatus, 202);

  assert.equal(receivedHeaders['x-api-key'], 'test-secret-key-123');
  assert.equal(receivedBody.event_id, 'evt_202_accepted');
});

test('IncidentForwarder retries on failure and enqueues to outbox', async (t) => {
  const outboxFile = path.join(testDir, 'outbox-retry.json');

  const forwarder = new IncidentForwarder({
    langflowWebhookUrl: 'http://127.0.0.1:54321/non-existent',
    langflowApiKey: 'test-key',
    forwardEnabled: true,
    outboxFile,
    maxRetries: 2,
    retryDelayMs: 50
  });

  t.after(() => forwarder.stop());

  const incident = {
    event_id: 'evt_retry_fail',
    message: 'Failed error test'
  };

  const res = await forwarder.forward(incident);
  assert.equal(res.success, false);
  assert.equal(res.status, 'failed');
  assert.equal(forwarder.outbox.count(), 1);
  assert.ok(fs.existsSync(outboxFile));
});

test('successful and warning logs cannot be forwarded or queued even when forwarding is enabled', async (t) => {
  const forwarder = new IncidentForwarder({ forwardEnabled: true, outboxFile: path.join(testDir, 'non-errors.json') });
  t.after(() => forwarder.stop());
  forwarder.sendHttpRequest = async () => { throw new Error('Non-error delivery must never be attempted'); };
  for (const level of ['info', 'warn', 'debug']) {
    const result = await forwarder.forward({ event_id: `evt_${level}`, level });
    assert.equal(result.status, 'not-required');
    assert.equal(forwarder.outbox.count(), 0);
  }
});
