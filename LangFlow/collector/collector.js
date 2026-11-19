const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const LANGFLOW_BASE_URL = (process.env.LANGFLOW_BASE_URL || 'http://localhost:7860').replace(/\/+$/, '');
const LANGFLOW_API_KEY = process.env.LANGFLOW_API_KEY || '';
const PM2_ERROR_LOG = path.resolve(__dirname, '..', process.env.PM2_ERROR_LOG || 'runtime/pm2/button-demo-error.log');
const SERVICE_NAME = process.env.SERVICE_NAME || 'button-demo';
const ENVIRONMENT = process.env.ENVIRONMENT || 'local';
const STATE_FILE = path.resolve(__dirname, '..', process.env.STATE_FILE || 'runtime/collector-state.json');

// Webhook URL can be explicitly set in .env, otherwise default to incident_to_jira flow endpoint
const WEBHOOK_URL = process.env.LANGFLOW_WEBHOOK_URL || `${LANGFLOW_BASE_URL}/api/v1/webhook/incident_to_jira`;

console.log(`[Collector] Starting Log Collector`);
console.log(`[Collector] Watching log file: ${PM2_ERROR_LOG}`);
console.log(`[Collector] State file: ${STATE_FILE}`);
console.log(`[Collector] Target Webhook: ${WEBHOOK_URL}`);
console.log(`[Collector] API Key configured: ${LANGFLOW_API_KEY ? 'Yes (configured)' : 'No (missing)'}`);

// Ensure directories exist
const logDir = path.dirname(PM2_ERROR_LOG);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const stateDir = path.dirname(STATE_FILE);
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
}

// Load or initialize state
let state = {
  lastPosition: 0,
  processedCount: 0,
  lastProcessedAt: null
};

if (fs.existsSync(STATE_FILE)) {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    state = JSON.parse(raw);
    console.log(`[Collector] Loaded previous state: position=${state.lastPosition}, processedCount=${state.processedCount}`);
  } catch (err) {
    console.warn(`[Collector] Failed to read state file, initializing fresh state: ${err.message}`);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Collector] Error saving state file: ${err.message}`);
  }
}

// Deterministic SHA-256 fingerprint generator
function computeFingerprint(incident) {
  const normalizedKey = [
    (incident.service || SERVICE_NAME).trim().toLowerCase(),
    (incident.route || 'unknown').trim(),
    (incident.error_type || 'Error').trim(),
    (incident.message || 'unknown').trim()
  ].join('|');

  return crypto.createHash('sha256').update(normalizedKey).digest('hex');
}

// Send incident event to LangFlow webhook with exponential backoff retry
async function sendToLangFlow(incident, attempt = 1, maxAttempts = 3) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (LANGFLOW_API_KEY) {
    headers['x-api-key'] = LANGFLOW_API_KEY;
  }

  const payloadStr = JSON.stringify(incident);

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: payloadStr
    });

    if (response.ok || response.status === 200 || response.status === 202) {
      let result = null;
      try {
        result = await response.json();
      } catch (e) {
        result = await response.text();
      }
      console.log(`[Collector] Incident successfully sent to LangFlow (HTTP ${response.status}). RequestId=${incident.request_id}, Fingerprint=${incident.fingerprint.slice(0, 8)}`);
      return { success: true, result };
    } else {
      const errText = await response.text().catch(() => '');
      console.warn(`[Collector] LangFlow returned HTTP ${response.status}: ${errText.slice(0, 200)} (Attempt ${attempt}/${maxAttempts})`);
      
      if (attempt < maxAttempts) {
        const delay = Math.pow(2, attempt) * 500;
        await new Promise(r => setTimeout(r, delay));
        return sendToLangFlow(incident, attempt + 1, maxAttempts);
      }
      return { success: false, status: response.status, error: errText };
    }
  } catch (netErr) {
    console.warn(`[Collector] Network failure sending to LangFlow: ${netErr.message} (Attempt ${attempt}/${maxAttempts})`);
    if (attempt < maxAttempts) {
      const delay = Math.pow(2, attempt) * 500;
      await new Promise(r => setTimeout(r, delay));
      return sendToLangFlow(incident, attempt + 1, maxAttempts);
    }
    return { success: false, error: netErr.message };
  }
}

let isProcessing = false;
let partialLineBuffer = '';

async function processNewLogLines() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    if (!fs.existsSync(PM2_ERROR_LOG)) {
      isProcessing = false;
      return;
    }

    const stats = fs.statSync(PM2_ERROR_LOG);
    const currentSize = stats.size;

    // Check if file was rotated or truncated
    if (currentSize < state.lastPosition) {
      console.log(`[Collector] Log file rotation/truncation detected. Resetting position from ${state.lastPosition} to 0.`);
      state.lastPosition = 0;
      partialLineBuffer = '';
    }

    if (currentSize > state.lastPosition) {
      const bytesToRead = currentSize - state.lastPosition;
      const buffer = Buffer.alloc(bytesToRead);

      const fd = fs.openSync(PM2_ERROR_LOG, 'r');
      fs.readSync(fd, buffer, 0, bytesToRead, state.lastPosition);
      fs.closeSync(fd);

      state.lastPosition = currentSize;

      const rawChunk = partialLineBuffer + buffer.toString('utf8');
      const lines = rawChunk.split(/\r?\n/);

      // The last element might be incomplete line, hold in buffer
      partialLineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Try parsing JSON
        let entry = null;
        try {
          entry = JSON.parse(trimmed);
        } catch (jsonErr) {
          // Ignore non-JSON lines
          continue;
        }

        // Only process error level
        if (!entry || entry.level !== 'error') {
          continue;
        }

        // Normalize incident data and ensure defaults
        const incident = {
          service: entry.service || SERVICE_NAME,
          environment: entry.environment || ENVIRONMENT,
          route: entry.route || 'unknown',
          error_type: entry.error_type || 'Error',
          message: entry.message || 'Unknown error occurred',
          // Keep the body valid after LangFlow's Message coercion. Raw
          // Windows backslashes and control newlines become invalid JSON
          // escapes there, so normalize the trace to readable single-line text.
          stack_trace: String(entry.stack_trace || '')
            .replace(/\\/g, '/')
            .replace(/\r?\n/g, ' | '),
          request_id: entry.request_id || crypto.randomUUID(),
          timestamp: entry.timestamp || new Date().toISOString(),
          log_reference: process.env.PM2_ERROR_LOG || 'runtime/pm2/button-demo-error.log'
        };

        const fingerprint = computeFingerprint(incident);
        incident.fingerprint = fingerprint;
        incident.fingerprint_prefix = fingerprint.slice(0, 8);

        console.log(`[Collector] Processing error incident: route=${incident.route}, requestId=${incident.request_id}, fingerprint=${incident.fingerprint_prefix}`);

        const result = await sendToLangFlow(incident);
        if (result.success) {
          state.processedCount++;
          state.lastProcessedAt = new Date().toISOString();
        } else {
          console.warn(`[Collector] Could not deliver incident ${incident.request_id} to LangFlow, will continue.`);
        }
      }

      saveState();
    }
  } catch (err) {
    console.error(`[Collector] Error processing logs: ${err.message}`);
  } finally {
    isProcessing = false;
  }
}

// Initial scan
processNewLogLines();

// Watch file for changes
try {
  fs.watch(PM2_ERROR_LOG, (eventType) => {
    if (eventType === 'change' || eventType === 'rename') {
      processNewLogLines();
    }
  });
} catch (e) {
  console.log(`[Collector] fs.watch not active yet (waiting for file creation). Polling will handle detection.`);
}

// Polling interval fallback for reliability on Windows
setInterval(processNewLogLines, 1000);
