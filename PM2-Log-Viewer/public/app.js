// State
let allLogs = [];
let eventSource = null;
let forwardEnabled = true;
let isConnected = false;
let pollingInterval = null;

// DOM Elements
const connectionStatusEl = document.getElementById('connectionStatus');
const connectionIndicatorEl = connectionStatusEl.querySelector('.status-indicator');
const connectionTextEl = document.getElementById('connectionText');
const toggleForwardBtn = document.getElementById('toggleForwardBtn');
const refreshBtn = document.getElementById('refreshBtn');
const flushOutboxBtn = document.getElementById('flushOutboxBtn');
const outboxCountEl = document.getElementById('outboxCount');

const metricTotalEl = document.getElementById('metricTotal');
const metricForwardedEl = document.getElementById('metricForwarded');
const metricPendingEl = document.getElementById('metricPending');
const metricOffsetEl = document.getElementById('metricOffset');
const metricSourceFileEl = document.getElementById('metricSourceFile');
const webhookTargetEl = document.getElementById('webhookTarget');
const visibleCountEl = document.getElementById('visibleCount');

const searchInput = document.getElementById('searchInput');
const statusFilter = document.getElementById('statusFilter');
const logsListEl = document.getElementById('logsList');

// Format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

// Format date
function formatDate(isoStr) {
  if (!isoStr) return 'N/A';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3
    });
  } catch (_) {
    return isoStr;
  }
}

// Fetch health & metrics
async function fetchHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    forwardEnabled = data.forwardEnabled;
    updateForwardingModeUI(forwardEnabled);

    metricTotalEl.textContent = data.totalLogs;
    metricOffsetEl.textContent = formatBytes(data.lastByteOffset || 0);
    metricPendingEl.textContent = data.outboxPending || 0;
    outboxCountEl.textContent = data.outboxPending || 0;

    const baseSource = data.logSource ? data.logSource.split(/[\\/]/).pop() : 'button-demo-error.log';
    metricSourceFileEl.textContent = `Source: ${baseSource}`;
    metricSourceFileEl.title = data.logSource;

    if (webhookTargetEl) {
      webhookTargetEl.textContent = data.logSourceExists ? 'Log Active' : 'Waiting for Log';
    }
  } catch (err) {
    console.warn('Health check failed:', err.message);
  }
}

function updateForwardingModeUI(enabled) {
  if (enabled) {
    toggleForwardBtn.className = 'mode-badge forwarding';
    toggleForwardBtn.textContent = 'Forwarding: ON';
    toggleForwardBtn.title = 'Active: New errors forward to LangFlow webhook. Click to toggle Dry-Run.';
  } else {
    toggleForwardBtn.className = 'mode-badge dryrun';
    toggleForwardBtn.textContent = 'Dry-Run: ON';
    toggleForwardBtn.title = 'Dry-Run active: Errors monitored without calling Jira. Click to enable forwarding.';
  }
}

// Fetch logs
async function fetchLogs() {
  try {
    const res = await fetch('/api/logs?limit=200');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allLogs = data.logs || [];
    renderLogs();
    updateMetrics();
  } catch (err) {
    logsListEl.innerHTML = `
      <div class="empty-state">
        <p class="text-danger">Failed to load logs: ${err.message}</p>
        <button class="btn btn-secondary btn-sm" onclick="fetchLogs()">Retry</button>
      </div>
    `;
  }
}

function updateMetrics() {
  metricTotalEl.textContent = allLogs.length;
  const forwardedCount = allLogs.filter(
    (l) => l.deliveryStatus === 'forwarded'
  ).length;
  metricForwardedEl.textContent = forwardedCount;
}

// Render filtered logs
function renderLogs() {
  const query = searchInput.value.toLowerCase().trim();
  const filter = statusFilter.value;

  const filtered = allLogs.filter((log) => {
    // Status filter
    if (filter !== 'all') {
      const st = (log.deliveryStatus || 'received').toLowerCase();
      if (filter === 'dry-run' && st !== 'dry-run') return false;
      if (filter !== 'dry-run' && st !== filter) return false;
    }

    // Text search
    if (!query) return true;
    return (
      (log.route && log.route.toLowerCase().includes(query)) ||
      (log.error_type && log.error_type.toLowerCase().includes(query)) ||
      (log.message && log.message.toLowerCase().includes(query)) ||
      (log.service && log.service.toLowerCase().includes(query)) ||
      (log.request_id && log.request_id.toLowerCase().includes(query)) ||
      (log.fingerprint && log.fingerprint.toLowerCase().includes(query)) ||
      (log.event_id && log.event_id.toLowerCase().includes(query))
    );
  });

  visibleCountEl.textContent = `${filtered.length} of ${allLogs.length} entries`;

  if (filtered.length === 0) {
    logsListEl.innerHTML = `
      <div class="empty-state">
        <p>No error log entries match the current filter.</p>
      </div>
    `;
    return;
  }

  logsListEl.innerHTML = '';
  for (const log of filtered) {
    const card = createLogCard(log);
    logsListEl.appendChild(card);
  }
}

// Build DOM Card for a single incident
function createLogCard(log) {
  const card = document.createElement('div');
  card.className = `log-card ${log.isNew ? 'highlight-new' : ''}`;
  card.id = `card-${log.event_id}`;

  const status = (log.deliveryStatus || 'received').toLowerCase();
  const statusDisplay = status.toUpperCase();

  const formattedTime = formatDate(log.timestamp);
  const stackLines = (log.stack_trace || '').split('\n').filter(Boolean).length;

  let deliveryDetailHtml = '';
  if (log.deliveryDetails) {
    const det = log.deliveryDetails;
    if (det.httpStatus) {
      deliveryDetailHtml = `<span>Accepted by LangFlow (HTTP ${det.httpStatus})</span>`;
    } else if (det.error) {
      deliveryDetailHtml = `<span class="text-danger">${det.error}</span>`;
    } else if (det.message) {
      deliveryDetailHtml = `<span>${det.message}</span>`;
    }
  }

  card.innerHTML = `
    <div class="log-card-header">
      <div class="card-tags">
        <span class="delivery-badge ${status}" id="badge-${log.event_id}">${statusDisplay}</span>
        <span class="tag-service">${escapeHtml(log.service || 'unknown')}</span>
        <span class="tag-env">${escapeHtml(log.environment || 'local')}</span>
        ${log.isNew ? '<span class="tag-new">NEW</span>' : ''}
      </div>
      <span class="log-time" title="${log.timestamp}">${formattedTime}</span>
    </div>

    <div class="log-card-body">
      <div class="log-title-row">
        <span class="log-route">${escapeHtml(log.route || '/')}</span>
        <span class="log-error-type">${escapeHtml(log.error_type || 'Error')}</span>
      </div>
      <div class="log-message">${escapeHtml(log.message || '')}</div>
    </div>

    <div class="log-metadata-bar">
      <div class="meta-item">
        <span class="meta-label">Request ID:</span>
        <span class="meta-value">${escapeHtml(log.request_id || 'N/A')}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Fingerprint:</span>
        <span class="meta-value">${escapeHtml(log.fingerprint || 'N/A')}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Ref:</span>
        <span class="meta-value">${escapeHtml(log.log_reference || log.event_id)}</span>
      </div>
    </div>

    ${
      log.stack_trace
        ? `
      <div class="stack-section">
        <button class="stack-toggle-btn" onclick="toggleStack('${log.event_id}')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          <span id="stack-btn-text-${log.event_id}">View Stack Trace (${stackLines} lines)</span>
        </button>
        <div class="stack-container" id="stack-cont-${log.event_id}">
          <button class="copy-stack-btn" onclick="copyStack('${log.event_id}', this)">Copy</button>
          <pre class="stack-code" id="stack-code-${log.event_id}">${escapeHtml(log.stack_trace)}</pre>
        </div>
      </div>
    `
        : ''
    }

    <div class="delivery-detail-row">
      <div class="delivery-info-text" id="delivery-info-${log.event_id}">
        ${deliveryDetailHtml}
      </div>
      <div>
        <button class="btn btn-outline btn-sm" onclick="retryIncident('${log.event_id}')" title="Retry forwarding this incident">
          Forward
        </button>
      </div>
    </div>
  `;

  return card;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

window.toggleStack = function (eventId) {
  const cont = document.getElementById(`stack-cont-${eventId}`);
  const btnText = document.getElementById(`stack-btn-text-${eventId}`);
  if (!cont) return;

  if (cont.classList.contains('open')) {
    cont.classList.remove('open');
    btnText.textContent = btnText.textContent.replace('Hide', 'View');
  } else {
    cont.classList.add('open');
    btnText.textContent = btnText.textContent.replace('View', 'Hide');
  }
};

window.copyStack = function (eventId, btn) {
  const codeEl = document.getElementById(`stack-code-${eventId}`);
  if (!codeEl) return;
  navigator.clipboard.writeText(codeEl.textContent).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = orig;
    }, 2000);
  });
};

window.retryIncident = async function (eventId) {
  try {
    const res = await fetch(`/api/retry/${eventId}`, { method: 'POST' });
    const data = await res.json();
    if (data.result) {
      updateIncidentStatusInDOM(eventId, data.result);
    }
    fetchHealth();
  } catch (err) {
    alert(`Retry request failed: ${err.message}`);
  }
};

function updateIncidentStatusInDOM(eventId, statusInfo) {
  const badge = document.getElementById(`badge-${eventId}`);
  const infoEl = document.getElementById(`delivery-info-${eventId}`);

  const status = (statusInfo.status || 'received').toLowerCase();
  if (badge) {
    badge.className = `delivery-badge ${status}`;
    badge.textContent = status.toUpperCase();
  }

  if (infoEl) {
    if (statusInfo.httpStatus) {
      infoEl.innerHTML = `<span>Accepted by LangFlow (HTTP ${statusInfo.httpStatus})</span>`;
    } else if (statusInfo.error) {
      infoEl.innerHTML = `<span class="text-danger">${escapeHtml(statusInfo.error)}</span>`;
    } else if (statusInfo.message) {
      infoEl.innerHTML = `<span>${escapeHtml(statusInfo.message)}</span>`;
    }
  }

  // Update in array
  const target = allLogs.find((l) => l.event_id === eventId);
  if (target) {
    target.deliveryStatus = status;
    target.deliveryDetails = statusInfo;
  }
  updateMetrics();
}

// Connect SSE stream
function setupEventStream() {
  if (eventSource) {
    eventSource.close();
  }

  connectionTextEl.textContent = 'Connecting...';
  connectionIndicatorEl.className = 'status-indicator';

  eventSource = new EventSource('/api/events/stream');

  eventSource.onopen = () => {
    isConnected = true;
    connectionIndicatorEl.className = 'status-indicator live';
    connectionTextEl.textContent = 'Live SSE Connected';
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  };

  eventSource.addEventListener('incident', (e) => {
    try {
      const incident = JSON.parse(e.data);
      // Prepend to array
      allLogs.unshift(incident);

      // Prepend to DOM if matches filter
      const card = createLogCard(incident);
      if (logsListEl.querySelector('.empty-state, .loading-state')) {
        logsListEl.innerHTML = '';
      }
      logsListEl.prepend(card);

      updateMetrics();
      fetchHealth();
    } catch (err) {
      console.error('Error parsing incident SSE:', err);
    }
  });

  eventSource.addEventListener('delivery_status', (e) => {
    try {
      const statusData = JSON.parse(e.data);
      if (statusData.eventId) {
        updateIncidentStatusInDOM(statusData.eventId, statusData);
      }
      fetchHealth();
    } catch (err) {
      console.error('Error parsing delivery_status SSE:', err);
    }
  });

  eventSource.addEventListener('config_change', (e) => {
    try {
      const conf = JSON.parse(e.data);
      if (typeof conf.forwardEnabled === 'boolean') {
        forwardEnabled = conf.forwardEnabled;
        updateForwardingModeUI(forwardEnabled);
      }
    } catch (_) {}
  });

  eventSource.onerror = () => {
    isConnected = false;
    connectionIndicatorEl.className = 'status-indicator disconnected';
    connectionTextEl.textContent = 'Disconnected (Polling)';
    eventSource.close();

    // Fallback to polling every 3s
    if (!pollingInterval) {
      pollingInterval = setInterval(() => {
        fetchLogs();
        fetchHealth();
      }, 3000);
    }

    // Try reconnecting SSE in 5s
    setTimeout(setupEventStream, 5000);
  };
}

// Event Listeners
refreshBtn.addEventListener('click', () => {
  fetchLogs();
  fetchHealth();
});

toggleForwardBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/toggle-forward', { method: 'POST' });
    const data = await res.json();
    forwardEnabled = data.forwardEnabled;
    updateForwardingModeUI(forwardEnabled);
  } catch (err) {
    alert(`Failed to toggle mode: ${err.message}`);
  }
});

flushOutboxBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/retry-all', { method: 'POST' });
    const data = await res.json();
    fetchHealth();
    fetchLogs();
  } catch (err) {
    alert(`Failed to flush outbox: ${err.message}`);
  }
});

searchInput.addEventListener('input', () => {
  renderLogs();
});

statusFilter.addEventListener('change', () => {
  renderLogs();
});

// Initial boot
fetchHealth();
fetchLogs();
setupEventStream();
