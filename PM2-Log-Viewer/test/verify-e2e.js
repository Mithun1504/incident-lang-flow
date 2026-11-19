const http = require('http');
const fs = require('fs');
const path = require('path');
const { startServer, stopServer, reader, forwarder } = require('../src/server');

async function run() {
  console.log('[E2E Verification] Starting PM2-Log-Viewer server...');
  const server = startServer(3001);

  // Allow reader to process initial check
  await new Promise((r) => setTimeout(r, 1000));

  console.log('[E2E Verification] 1. Testing GET /api/health');
  const healthRes = await fetch('http://localhost:3001/api/health');
  if (healthRes.status !== 200) {
    throw new Error(`Expected health HTTP 200, got ${healthRes.status}`);
  }
  const health = await healthRes.json();
  console.log('   Health response:', JSON.stringify(health, null, 2));

  if (health.status !== 'ok') throw new Error('Health status is not ok');
  if (health.port !== 3001) throw new Error('Port is not 3001');
  if (!health.logSourceExists) throw new Error(`Log source does not exist: ${health.logSource}`);
  if (health.totalLogs < 29) throw new Error(`Expected at least 29 logs, got ${health.totalLogs}`);

  console.log('\n[E2E Verification] 2. Testing GET /api/logs');
  const logsRes = await fetch('http://localhost:3001/api/logs?limit=5');
  const logsData = await logsRes.json();
  console.log(`   Retrieved ${logsData.logs.length} of ${logsData.total} logs`);
  console.log('   Newest log sample:');
  console.log('   - Event ID:', logsData.logs[0].event_id);
  console.log('   - Service:', logsData.logs[0].service);
  console.log('   - Route:', logsData.logs[0].route);
  console.log('   - Error Type:', logsData.logs[0].error_type);
  console.log('   - Message:', logsData.logs[0].message);
  console.log('   - Delivery Status:', logsData.logs[0].deliveryStatus);
  console.log('   - Fingerprint:', logsData.logs[0].fingerprint);
  console.log('   - Stack trace normalized:', logsData.logs[0].stack_trace.includes('C:/'));

  console.log('\n[E2E Verification] 3. Testing GET /api/logs/:eventId');
  const targetId = logsData.logs[0].event_id;
  const singleRes = await fetch(`http://localhost:3001/api/logs/${targetId}`);
  if (singleRes.status !== 200) {
    throw new Error(`Expected HTTP 200 for single log, got ${singleRes.status}`);
  }
  const singleLog = await singleRes.json();
  if (singleLog.event_id !== targetId) throw new Error('Event ID mismatch');

  console.log('\n[E2E Verification] 4. Verifying State Persistence');
  const statePath = path.resolve(__dirname, '../runtime/log-viewer-state.json');
  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found at ${statePath}`);
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  console.log('   State file contents:', state);
  if (!state.lastByteOffset || state.lastByteOffset <= 0) {
    throw new Error('Expected positive lastByteOffset');
  }

  console.log('\n[E2E Verification] All automated checks passed successfully!');
  await new Promise((r) => stopServer(r));
  process.exit(0);
}

run().catch((err) => {
  console.error('[E2E Verification Failed]:', err);
  process.exit(1);
});
