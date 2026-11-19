const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startServer, stopServer, reader, forwarder } = require('../src/server');

async function verify() {
  console.log('[Forwarding Test] Starting PM2-Log-Viewer on port 3001...');
  const server = startServer(3001);

  // Wait 1.5s for initial reading
  await new Promise((r) => setTimeout(r, 1500));

  const initialLogsRes = await fetch('http://localhost:3001/api/logs');
  const initialData = await initialLogsRes.json();
  const initialCount = initialData.total;
  console.log(`[Forwarding Test] Initial log count: ${initialCount}`);

  // Construct a new PM2 error line
  const testRequestId = `test-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  const testErrorLine = JSON.stringify({
    level: 'error',
    service: 'button-demo',
    environment: 'local',
    route: '/api/fail-one',
    error_type: 'IntentionalPrototypeError',
    message: `Test failure from button one (E2E Test ${testRequestId})`,
    stack_trace: `IntentionalPrototypeError: Test failure\n    at C:\\Users\\USER\\Desktop\\Ellipsonic-Projects\\LangFlow\\app\\server.js:60:20`,
    request_id: testRequestId,
    timestamp: now
  }) + '\n';

  const logFilePath = reader.logSource;
  console.log(`[Forwarding Test] Appending new error entry to ${logFilePath}...`);
  fs.appendFileSync(logFilePath, testErrorLine, 'utf8');

  // Trigger check or wait for poll
  reader.checkFile('test-new-append');

  // Wait 3 seconds for forwarder to POST to LangFlow and receive HTTP 200/202
  console.log('[Forwarding Test] Waiting for forwarder to dispatch incident to LangFlow...');
  await new Promise((r) => setTimeout(r, 3500));

  // Query /api/logs
  const updatedLogsRes = await fetch('http://localhost:3001/api/logs?limit=5');
  const updatedData = await updatedLogsRes.json();

  console.log(`[Forwarding Test] Updated log count: ${updatedData.total} (was ${initialCount})`);
  if (updatedData.total <= initialCount) {
    throw new Error('New log entry was not picked up by PM2-Log-Viewer');
  }

  const latestLog = updatedData.logs[0];
  console.log('[Forwarding Test] Latest detected log:');
  console.log('   - Event ID:', latestLog.event_id);
  console.log('   - Request ID:', latestLog.request_id);
  console.log('   - Route:', latestLog.route);
  console.log('   - Error Type:', latestLog.error_type);
  console.log('   - Message:', latestLog.message);
  console.log('   - Delivery Status:', latestLog.deliveryStatus);
  console.log('   - Delivery Details:', latestLog.deliveryDetails);

  if (latestLog.request_id !== testRequestId) {
    throw new Error(`Expected latest log to be ${testRequestId}, but got ${latestLog.request_id}`);
  }

  if (latestLog.deliveryStatus !== 'forwarded') {
    throw new Error(`Expected deliveryStatus to be 'forwarded', but got '${latestLog.deliveryStatus}'`);
  }

  console.log('\n[Forwarding Test] SUCCESS! Incident was normalized and accepted by LangFlow webhook.');

  // Test Server Restart to verify zero duplicate dispatch
  console.log('\n[Forwarding Test] Testing server restart behavior...');
  await new Promise((r) => stopServer(r));

  console.log('[Forwarding Test] Restarting server...');
  const restartedServer = startServer(3001);
  await new Promise((r) => setTimeout(r, 1500));

  const restartLogsRes = await fetch('http://localhost:3001/api/logs');
  const restartData = await restartLogsRes.json();
  console.log(`[Forwarding Test] After restart total logs: ${restartData.total}`);
  if (restartData.total !== updatedData.total) {
    throw new Error(`Log count changed unexpectedly across restart (${restartData.total} vs ${updatedData.total})`);
  }

  console.log('[Forwarding Test] Restart verified: no duplicates, state offset preserved!');
  await new Promise((r) => stopServer(r));
  process.exit(0);
}

verify().catch((err) => {
  console.error('[Forwarding Test FAILED]:', err);
  process.exit(1);
});
