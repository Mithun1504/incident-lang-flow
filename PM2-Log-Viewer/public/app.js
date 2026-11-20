const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const entries = new Map();
const expanded = new Set();
let selectedLevel = 'all';
let forwardEnabled = true;
let eventSource;
let reconnectTimer;
let pollingTimer;
let toastTimer;
const labels = { forwarded: 'Accepted', received: 'Received', forwarding: 'Sending', retrying: 'Retrying', failed: 'Failed', 'dry-run': 'Dry run', 'not-required': 'Not required' };

function toast(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  return data;
}
function sortedLogs() { return [...entries.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)); }
function upsert(logs) {
  for (const log of logs) entries.set(log.event_id, { ...entries.get(log.event_id), ...log });
  const recent = sortedLogs();
  recent.slice(500).forEach(log => { entries.delete(log.event_id); expanded.delete(log.event_id); });
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
}
function matches(log) {
  const level = log.level || 'error';
  if (selectedLevel === 'error' && level !== 'error') return false;
  if (selectedLevel === 'success' && !(log.status_code >= 200 && log.status_code < 400)) return false;
  if (selectedLevel === 'warn' && level !== 'warn') return false;
  const status = log.deliveryStatus || (level === 'error' ? 'received' : 'not-required');
  if ($('statusFilter').value !== 'all' && status !== $('statusFilter').value) return false;
  const query = $('searchInput').value.trim().toLowerCase();
  return !query || ['route', 'message', 'request_id', 'service', 'error_type', 'fingerprint', 'method', 'status_code'].some(key => String(log[key] || '').toLowerCase().includes(query));
}
function details(log) {
  const fields = [['Request ID', log.request_id], ['Service / environment', `${log.service} / ${log.environment}`], ['Timestamp', log.timestamp], ['Source reference', log.log_reference], ['Fingerprint', log.fingerprint || 'Not applicable'], ['Event ID', log.event_id]];
  const info = log.deliveryDetails || {};
  const note = log.level !== 'error' ? 'Recorded for visibility. This request does not trigger a Jira ticket.' : info.error || (info.httpStatus ? `Accepted by LangFlow (HTTP ${info.httpStatus}). Webhook acceptance does not confirm ticket creation.` : info.message || 'This error is eligible for incident automation.');
  return `<tr class="log-details"><td colspan="7"><div class="detail-content" id="detail-${escapeHtml(log.event_id)}"><div class="detail-heading"><strong>${escapeHtml(log.message)}</strong>${log.level === 'error' ? `<button class="button small" data-retry="${escapeHtml(log.event_id)}">Retry error delivery</button>` : ''}</div><dl class="detail-grid">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value || '—')}</dd></div>`).join('')}</dl>${log.stack_trace ? `<div class="stack-header"><span>Stack trace</span><button class="button small" data-copy="${escapeHtml(log.event_id)}">Copy trace</button></div><pre>${escapeHtml(log.stack_trace)}</pre>` : ''}<div class="delivery-note ${info.error ? 'error' : ''}">${escapeHtml(note)}</div></div></td></tr>`;
}
function row(log) {
  const level = log.level || 'error';
  const status = log.deliveryStatus || (level === 'error' ? 'received' : 'not-required');
  const isOpen = expanded.has(log.event_id);
  const statusCode = log.status_code || (level === 'error' ? 500 : null);
  const statusClass = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : '';
  return `<tr class="log-row ${isOpen ? 'selected' : ''}"><td><time class="time" datetime="${escapeHtml(log.timestamp)}" title="${escapeHtml(new Date(log.timestamp).toLocaleString())}">${escapeHtml(formatTime(log.timestamp))}</time></td><td><span class="level ${escapeHtml(level)}">${escapeHtml(level)}</span></td><td><button class="endpoint-button" data-expand="${escapeHtml(log.event_id)}" aria-expanded="${isOpen}" aria-controls="detail-${escapeHtml(log.event_id)}"><span class="method">${escapeHtml(log.method || 'POST')}</span><span class="route">${escapeHtml(log.route)}</span></button></td><td>${statusCode ? `<span class="http-status ${statusClass}">${statusCode}</span>` : '<span class="duration">—</span>'}</td><td class="duration">${Number.isFinite(log.duration_ms) ? `${log.duration_ms.toFixed(1)} ms` : '—'}</td><td><span class="delivery ${escapeHtml(status)}">${escapeHtml(labels[status] || status)}</span></td><td><button class="detail-toggle" data-expand="${escapeHtml(log.event_id)}" aria-label="${isOpen ? 'Hide' : 'Show'} details for ${escapeHtml(log.route)}" aria-expanded="${isOpen}" aria-controls="detail-${escapeHtml(log.event_id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button></td></tr>${isOpen ? details(log) : `<tr class="log-details" hidden><td colspan="7"><div id="detail-${escapeHtml(log.event_id)}"></div></td></tr>`}`;
}
function render() {
  const active = document.activeElement;
  const focusedId = active?.dataset?.expand;
  const focusedClass = active?.className;
  const logs = sortedLogs(); const visible = logs.filter(matches);
  $('visibleCount').textContent = `${visible.length} of ${logs.length} entries`;
  $('logsList').innerHTML = visible.length ? visible.map(row).join('') : `<tr><td colspan="7" class="empty-state"><strong>${logs.length ? 'No matching requests' : 'Waiting for application activity'}</strong><span>${logs.length ? 'Try a different search or filter.' : 'Open a page in the workspace to see successful requests here. Service failures appear alongside them.'}</span></td></tr>`;
  if (focusedId) {
    const replacement = [...$('logsList').querySelectorAll('[data-expand]')].find(button => button.dataset.expand === focusedId && button.className === focusedClass);
    replacement?.focus({ preventScroll: true });
  }
}
function mode(enabled) {
  forwardEnabled = enabled;
  $('toggleForwardBtn').textContent = enabled ? 'Error forwarding on' : 'Error forwarding paused';
  $('toggleForwardBtn').setAttribute('aria-pressed', String(enabled));
}
async function fetchHealth() {
  const data = await request('/api/health'); mode(data.forwardEnabled);
  for (const [id, value] of [['metricTotal', data.totalLogs], ['metricSuccess', data.successfulRequests || 0], ['metricErrors', data.totalErrors || 0], ['metricForwarded', data.forwardedErrors || 0], ['metricPending', data.outboxPending], ['outboxCount', data.outboxPending]]) $(id).textContent = value;
  $('flushOutboxBtn').disabled = !data.outboxPending || !forwardEnabled;
  const sources = data.logSources || [{ path: data.logSource, exists: data.logSourceExists }];
  $('sourceSummary').textContent = `${sources.filter(s => s.exists).length} of ${sources.length} sources active`;
  $('sourceList').innerHTML = sources.map(s => `<div class="source-item"><span class="source-state">${s.exists ? 'Active' : 'Waiting for file'}</span><code>${escapeHtml(s.path)}</code></div>`).join('');
}
async function fetchLogs() {
  const data = await request('/api/logs?limit=500'); upsert(data.logs || []); render();
  $('lastUpdated').textContent = `Updated ${formatTime(new Date().toISOString()).split('.')[0]}`;
}
async function refresh() {
  try { await Promise.all([fetchLogs(), fetchHealth()]); $('loadError').hidden = true; }
  catch (error) { $('loadError').textContent = `${error.message} Check the viewer connection, then refresh.`; $('loadError').hidden = false; }
}
function connect() {
  clearTimeout(reconnectTimer); eventSource?.close();
  eventSource = new EventSource('/api/events/stream');
  eventSource.onopen = () => {
    $('connectionStatus').className = 'connection connected'; $('connectionText').textContent = 'Live connection';
    clearInterval(pollingTimer); pollingTimer = null; refresh();
  };
  eventSource.addEventListener('incident', event => {
    const log = JSON.parse(event.data); upsert([log]); render(); fetchHealth().catch(() => {});
    $('lastUpdated').textContent = `Last request ${formatTime(log.timestamp).split('.')[0]}`;
  });
  eventSource.addEventListener('delivery_status', event => {
    const info = JSON.parse(event.data); const log = entries.get(info.eventId);
    if (log) { log.deliveryStatus = info.status; log.deliveryDetails = info; render(); }
    fetchHealth().catch(() => {});
  });
  eventSource.addEventListener('config_change', event => { mode(JSON.parse(event.data).forwardEnabled); fetchHealth().catch(() => {}); });
  eventSource.onerror = () => {
    $('connectionStatus').className = 'connection disconnected'; $('connectionText').textContent = 'Reconnecting';
    eventSource.close();
    if (!pollingTimer) pollingTimer = setInterval(refresh, 3000);
    reconnectTimer = setTimeout(connect, 5000);
  };
}
document.querySelectorAll('[data-level]').forEach(button => button.onclick = () => {
  selectedLevel = button.dataset.level;
  document.querySelectorAll('[data-level]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button))); render();
});
$('searchInput').addEventListener('input', render); $('statusFilter').addEventListener('change', render);
$('refreshBtn').onclick = refresh;
$('toggleForwardBtn').onclick = async () => { try { const data = await request('/api/toggle-forward', { method: 'POST' }); mode(data.forwardEnabled); await fetchHealth(); } catch (error) { toast(error.message); } };
$('flushOutboxBtn').onclick = async event => {
  event.currentTarget.disabled = true;
  try { await request('/api/retry-all', { method: 'POST' }); toast('Eligible queued errors have been retried.'); await refresh(); }
  catch (error) { toast(error.message); }
};
$('logsList').addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  const id = button.dataset.expand || button.dataset.retry || button.dataset.copy;
  const log = entries.get(id); if (!log) return;
  if (button.dataset.expand) { expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); return; }
  if (button.dataset.copy) { try { await navigator.clipboard.writeText(log.stack_trace); toast('Stack trace copied.'); } catch (_) { toast('Clipboard access is unavailable. Select and copy the trace.'); } return; }
  button.disabled = true;
  try { await request(`/api/retry/${encodeURIComponent(id)}`, { method: 'POST' }); await refresh(); }
  catch (error) { toast(error.message); button.disabled = false; }
});
refresh(); connect();
