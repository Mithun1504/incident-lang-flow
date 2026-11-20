const crypto = require('crypto');

/**
 * Strips ANSI escape codes from text (e.g. terminal colors)
 */
function stripAnsi(str) {
  if (typeof str !== 'string') return '';
  return str.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ''
  );
}

/**
 * Normalizes Windows file paths and stack traces for consistent JSON transport.
 * Standardizes backslashes to forward slashes in path locations and trims invalid control chars.
 */
function normalizeStackTrace(stackTrace) {
  if (!stackTrace) return '';
  let cleaned = stripAnsi(String(stackTrace));
  
  // Normalize Windows absolute paths (e.g., C:\Users\... -> C:/Users/...)
  cleaned = cleaned.replace(/([A-Za-z]:\\[^\s\):]+)/g, (match) => {
    return match.replace(/\\/g, '/');
  });

  return cleaned.trim();
}

/**
 * Generates a deterministic SHA-256 fingerprint for error deduplication/correlation
 */
function generateFingerprint(service, route, errorType, message) {
  const normalizedMessage = String(message || '')
    .trim()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TIMESTAMP>');
    
  const key = `${service || ''}|${route || ''}|${errorType || ''}|${normalizedMessage}`;
  return crypto.createHash('sha256').update(key).digest('hex').substring(0, 16);
}

/**
 * Normalizes a raw PM2 log object into the standard incident payload
 */
function normalizeIncident(rawEntry, options = {}) {
  const level = String(rawEntry.level || 'error').toLowerCase();
  const rawStatus = Number(rawEntry.status_code ?? rawEntry.http_status);
  const statusCode = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus : level === 'error' ? 500 : null;
  const service = rawEntry.service || options.service || 'unknown-service';
  const environment = rawEntry.environment || options.environment || 'local';
  const route = rawEntry.route || options.route || 'unknown-route';
  const errorType =
    rawEntry.error_type || rawEntry.name || rawEntry.type || (level === 'error' ? 'UnknownError' : null);
  const message = rawEntry.message || 'No error message provided';
  const stackTrace = normalizeStackTrace(
    rawEntry.stack_trace || rawEntry.stack || ''
  );
  const requestId =
    rawEntry.request_id ||
    rawEntry.requestId ||
    rawEntry.reqId ||
    crypto.randomUUID();

  // Validate or construct timestamp
  let timestamp = rawEntry.timestamp;
  if (!timestamp || isNaN(Date.parse(timestamp))) {
    timestamp = new Date().toISOString();
  }

  // Generate unique event_id
  const eventKey = [service, requestId, timestamp, route, level].join('|');
  const eventId = rawEntry.event_id || `evt_${crypto.createHash('sha256').update(eventKey).digest('hex').slice(0, 24)}`;

  // Log reference
  const logReference =
    rawEntry.log_reference ||
    `pm2:${service}:${requestId}`;

  // Deterministic fingerprint
  const fingerprint =
    level === 'error' ? rawEntry.fingerprint || generateFingerprint(service, route, errorType, message) : null;

  return {
    source: 'pm2-log-viewer',
    level,
    method: rawEntry.method || 'POST',
    status_code: statusCode,
    duration_ms: Number.isFinite(rawEntry.duration_ms) ? rawEntry.duration_ms : null,
    service,
    environment,
    route,
    error_type: errorType,
    message,
    stack_trace: stackTrace,
    request_id: requestId,
    timestamp,
    log_reference: logReference,
    event_id: eventId,
    fingerprint
  };
}

module.exports = {
  normalizeIncident,
  normalizeStackTrace,
  generateFingerprint,
  stripAnsi
};
