const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PM2LogReader = require('../src/logReader');

const testDir = path.join(__dirname, 'tmp');

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

test('PM2LogReader reads lines incrementally, tracks offset, and ignores non-JSON & non-errors', async (t) => {
  const logFile = path.join(testDir, 'test-app.log');
  const stateFile = path.join(testDir, 'test-state.json');

  // Initialize with initial log content
  const initialContent = [
    '{"level":"info","message":"Application started"}',
    'Random non-json line here',
    '{"level":"error","service":"test-svc","route":"/test","error_type":"Error","message":"Error 1","timestamp":"2026-11-19T10:00:00.000Z"}'
  ].join('\n') + '\n';

  fs.writeFileSync(logFile, initialContent, 'utf8');

  const reader = new PM2LogReader({
    pm2LogSource: logFile,
    logStateFile: stateFile,
    pollIntervalMs: 200
  });

  t.after(() => {
    reader.stop();
  });

  reader.start();

  // First boot should load existing error into logs cache without forwarding
  const logs = reader.getLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, 'Error 1');
  assert.equal(logs[0].deliveryStatus, 'received');
  assert.ok(reader.lastByteOffset > 0);

  // Now append a second error
  const newContent = [
    '{"level":"info","message":"Just an info"}',
    '{"level":"error","service":"test-svc","route":"/test2","error_type":"Error","message":"Error 2","timestamp":"2026-11-19T10:05:00.000Z"}'
  ].join('\n') + '\n';

  let newIncidentReceived = null;
  reader.on('incident', (inc, isNew) => {
    if (isNew && inc.message === 'Error 2') {
      newIncidentReceived = inc;
    }
  });

  fs.appendFileSync(logFile, newContent, 'utf8');
  reader.checkFile('test-append');

  assert.ok(newIncidentReceived, 'Expected new incident to be emitted');
  assert.equal(newIncidentReceived.message, 'Error 2');
  assert.equal(reader.getLogs().length, 2);
});

test('PM2LogReader handles log rotation or truncation', async (t) => {
  const logFile = path.join(testDir, 'test-rotate.log');
  const stateFile = path.join(testDir, 'test-rotate-state.json');

  // Long initial content
  fs.writeFileSync(
    logFile,
    '{"level":"error","service":"test","route":"/a","error_type":"Err","message":"Err A"}\n'.repeat(5),
    'utf8'
  );

  const reader = new PM2LogReader({
    pm2LogSource: logFile,
    logStateFile: stateFile,
    pollIntervalMs: 200
  });

  t.after(() => reader.stop());
  reader.start();

  const originalOffset = reader.lastByteOffset;
  assert.ok(originalOffset > 50);

  // Truncate file to smaller content (rotation)
  fs.writeFileSync(
    logFile,
    '{"level":"error","service":"test","route":"/b","error_type":"Err","message":"Rotated Err"}\n',
    'utf8'
  );

  reader.checkFile('test-truncate');

  // Offset should have reset and re-read the rotated file
  assert.ok(reader.lastByteOffset < originalOffset);
  const found = reader.getLogs().some((l) => l.message === 'Rotated Err');
  assert.ok(found, 'Should have processed error from rotated file');
});
