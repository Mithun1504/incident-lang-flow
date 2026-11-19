const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const PM2LogReader = require('./logReader');
const IncidentForwarder = require('./forwarder');

const app = express();
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Initialize Reader and Forwarder
const reader = new PM2LogReader(config);
const forwarder = new IncidentForwarder(config);

// Active SSE client connections
const sseClients = new Set();

function broadcastSse(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

// When a new error incident is detected
reader.on('incident', async (entry, isNew) => {
  // Broadcast to all connected SSE clients
  broadcastSse('incident', entry);

  // If this is a newly appended error (not historical on boot), forward it
  if (isNew) {
    try {
      const result = await forwarder.forward(entry);
      reader.updateDeliveryStatus(entry.event_id, result);
    } catch (err) {
      console.error(`[Server] Error forwarding incident ${entry.event_id}:`, err.message);
    }
  }
});

// When delivery status changes (e.g., retrying, forwarded, failed)
forwarder.onStatusChange((eventId, statusInfo) => {
  reader.updateDeliveryStatus(eventId, statusInfo);
  broadcastSse('delivery_status', { eventId, ...statusInfo });
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'pm2-log-viewer',
    port: config.port,
    uptimeSeconds: Math.floor(process.uptime()),
    forwardEnabled: forwarder.forwardEnabled,
    logSource: config.pm2LogSource,
    logSourceExists: fs.existsSync(config.pm2LogSource),
    lastByteOffset: reader.lastByteOffset,
    totalLogs: reader.getLogs().length,
    outboxPending: forwarder.outbox.count(),
    timestamp: new Date().toISOString()
  });
});

// GET /api/logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const allLogs = reader.getLogs();
  const sliced = allLogs.slice(0, limit);

  // Enrich with latest live delivery status from forwarder
  const enriched = sliced.map((log) => {
    const liveStatus = forwarder.getStatus(log.event_id);
    return {
      ...log,
      deliveryStatus: liveStatus.status !== 'received' ? liveStatus.status : log.deliveryStatus,
      deliveryDetails: liveStatus
    };
  });

  res.json({
    total: allLogs.length,
    limit,
    logs: enriched
  });
});

// GET /api/logs/:eventId
app.get('/api/logs/:eventId', (req, res) => {
  const { eventId } = req.params;
  const log = reader.getLogByEventId(eventId);
  if (!log) {
    return res.status(404).json({ error: `Log event not found: ${eventId}` });
  }

  const liveStatus = forwarder.getStatus(log.event_id);
  res.json({
    ...log,
    deliveryStatus: liveStatus.status !== 'received' ? liveStatus.status : log.deliveryStatus,
    deliveryDetails: liveStatus
  });
});

// GET /api/events/stream - Server-Sent Events
app.get('/api/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write(': connected\n\n');

  const client = { id: Date.now(), res };
  sseClients.add(client);

  // Send periodic ping to prevent connection drops
  const pingTimer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      clearInterval(pingTimer);
      sseClients.delete(client);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(pingTimer);
    sseClients.delete(client);
  });
});

// POST /api/retry/:eventId - Retry forwarding a specific log manually
app.post('/api/retry/:eventId', async (req, res) => {
  const { eventId } = req.params;
  const log = reader.getLogByEventId(eventId);
  if (!log) {
    return res.status(404).json({ error: `Log event not found: ${eventId}` });
  }

  const result = await forwarder.forward(log);
  reader.updateDeliveryStatus(eventId, result);
  res.json({ success: result.success, result });
});

// POST /api/retry-all - Trigger manual outbox flush
app.post('/api/retry-all', async (req, res) => {
  await forwarder.drainOutbox();
  res.json({ success: true, pendingCount: forwarder.outbox.count() });
});

// POST /api/toggle-forward - Toggle forwarding mode (live vs dry-run)
app.post('/api/toggle-forward', (req, res) => {
  forwarder.forwardEnabled = !forwarder.forwardEnabled;
  broadcastSse('config_change', { forwardEnabled: forwarder.forwardEnabled });
  res.json({ forwardEnabled: forwarder.forwardEnabled });
});

let server = null;

function startServer(port = config.port) {
  reader.start();
  server = app.listen(port, () => {
    console.log(`[PM2-Log-Viewer] Server running at http://localhost:${port}`);
    console.log(`[PM2-Log-Viewer] Monitoring log file: ${config.pm2LogSource}`);
    console.log(`[PM2-Log-Viewer] Forwarding enabled: ${forwarder.forwardEnabled}`);
    console.log(`[PM2-Log-Viewer] Webhook target: ${config.langflowWebhookUrl}`);
  });
  return server;
}

function stopServer(callback) {
  reader.stop();
  forwarder.stop();
  if (server) {
    server.close(callback);
  } else if (callback) {
    callback();
  }
}

// Start if executed directly
if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  stopServer,
  reader,
  forwarder
};
