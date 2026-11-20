const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const PM2LogReader = require('./logReader');
const IncidentForwarder = require('./forwarder');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public'), { etag: false, maxAge: 0 }));
const reader = new PM2LogReader(config);
const outReader = new PM2LogReader({ ...config, pm2LogSource: config.pm2OutLogSource, logStateFile: config.outLogStateFile });
const readers = config.pm2OutLogSource === config.pm2LogSource ? [reader] : [reader, outReader];
const forwarder = new IncidentForwarder(config);
const sseClients = new Set();

function broadcastSse(type, data) {
  for (const res of sseClients) {
    try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch (_) { sseClients.delete(res); }
  }
}
function getLogs() {
  return readers.flatMap(r => r.getLogs()).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 500);
}
function findLog(id) { return readers.map(r => r.getLogByEventId(id)).find(Boolean); }
function updateStatus(id, status) { for (const r of readers) if (r.getLogByEventId(id)) r.updateDeliveryStatus(id, status); }
function enrich(log) {
  const live = forwarder.getStatus(log.event_id);
  return { ...log, deliveryStatus: live.status !== 'received' ? live.status : log.deliveryStatus, deliveryDetails: live.status !== 'received' ? live : log.deliveryDetails || live };
}
for (const source of readers) {
  source.on('error', error => console.error('[LogReader]', error.message));
  source.on('incident', async (entry, isNew) => {
    broadcastSse('incident', entry);
    if (isNew && entry.level === 'error') {
      try { updateStatus(entry.event_id, await forwarder.forward(entry)); }
      catch (error) { console.error('[Forwarder]', error.message); }
    }
  });
}
forwarder.onStatusChange((eventId, status) => {
  updateStatus(eventId, status);
  broadcastSse('delivery_status', { eventId, ...status });
});
app.get('/api/health', (req, res) => {
  const logs = getLogs().map(enrich);
  res.json({ status: 'ok', service: 'pm2-log-viewer', port: config.port,
    uptimeSeconds: Math.floor(process.uptime()), forwardEnabled: forwarder.forwardEnabled,
    logSource: config.pm2LogSource, logSourceExists: readers.some(r => fs.existsSync(r.logSource)),
    logSources: readers.map(r => ({ path: r.logSource, exists: fs.existsSync(r.logSource), offset: r.lastByteOffset })),
    lastByteOffset: readers.reduce((sum, r) => sum + r.lastByteOffset, 0), totalLogs: logs.length,
    successfulRequests: logs.filter(l => l.status_code >= 200 && l.status_code < 400).length,
    totalErrors: logs.filter(l => l.level === 'error').length,
    forwardedErrors: logs.filter(l => l.deliveryStatus === 'forwarded').length,
    outboxPending: forwarder.outbox.count(), timestamp: new Date().toISOString() });
});
function limit(req) { return Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100)); }
app.get('/api/logs', (req, res) => {
  const logs = getLogs();
  res.json({ total: logs.length, limit: limit(req), logs: logs.slice(0, limit(req)).map(enrich) });
});
app.get('/api/incidents', (req, res) => {
  const incidents = getLogs().filter(l => l.level === 'error');
  res.json({ source: 'pm2-log-viewer', total: incidents.length, limit: limit(req), incidents: incidents.slice(0, limit(req)).map(enrich) });
});
app.get('/api/logs/:eventId', (req, res) => {
  const log = findLog(req.params.eventId);
  if (!log) return res.status(404).json({ error: 'Log event not found.' });
  res.json(enrich(log));
});
app.get('/api/events/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});
app.post('/api/retry/:eventId', async (req, res) => {
  const log = findLog(req.params.eventId);
  if (!log) return res.status(404).json({ error: 'Log event not found.' });
  if (log.level !== 'error') return res.status(400).json({ error: 'Successful and informational requests do not trigger Jira automation.' });
  const result = await forwarder.forward(log);
  updateStatus(log.event_id, result);
  res.json({ success: result.success, result });
});
app.post('/api/retry-all', async (req, res) => {
  await forwarder.drainOutbox();
  res.json({ success: true, pendingCount: forwarder.outbox.count() });
});
app.post('/api/toggle-forward', (req, res) => {
  forwarder.forwardEnabled = !forwarder.forwardEnabled;
  broadcastSse('config_change', { forwardEnabled: forwarder.forwardEnabled });
  res.json({ forwardEnabled: forwarder.forwardEnabled });
});
let server;
function startServer(port = config.port) {
  readers.forEach(r => r.start());
  server = app.listen(port, () => console.log(`[PM2-Log-Viewer] Activity logs at http://localhost:${port}`));
  return server;
}
function stopServer(callback) {
  readers.forEach(r => r.stop()); forwarder.stop();
  for (const res of sseClients) res.end();
  sseClients.clear();
  if (server) server.close(callback); else if (callback) callback();
}
if (require.main === module) startServer();
module.exports = { app, startServer, stopServer, reader, outReader, forwarder };
