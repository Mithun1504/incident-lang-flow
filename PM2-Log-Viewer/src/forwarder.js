const OutboxManager = require('./outbox');

class IncidentForwarder {
  constructor(config) {
    this.webhookUrl = config.langflowWebhookUrl;
    this.apiKey = config.langflowApiKey;
    this.forwardEnabled = config.forwardEnabled;
    this.maxRetries = config.maxRetries || 3;
    this.retryDelayMs = config.retryDelayMs || 1000;
    this.outbox = new OutboxManager(config.outboxFile);
    this.deliveryStatusMap = new Map(); // eventId -> { status, lastAttempt, error, httpStatus }
    this.onStatusChangeCallbacks = [];

    // Periodic outbox drainer (every 10 seconds)
    this.drainTimer = setInterval(() => {
      this.drainOutbox();
    }, 10000);
    if (this.drainTimer.unref) {
      this.drainTimer.unref();
    }
  }

  onStatusChange(callback) {
    this.onStatusChangeCallbacks.push(callback);
  }

  emitStatusChange(eventId, statusInfo) {
    this.deliveryStatusMap.set(eventId, statusInfo);
    for (const cb of this.onStatusChangeCallbacks) {
      try {
        cb(eventId, statusInfo);
      } catch (e) {
        console.error('[Forwarder] Error in status change callback:', e.message);
      }
    }
  }

  getStatus(eventId) {
    return (
      this.deliveryStatusMap.get(eventId) || {
        status: 'received',
        lastAttempt: null,
        error: null,
        httpStatus: null
      }
    );
  }

  setStatus(eventId, statusInfo) {
    this.emitStatusChange(eventId, statusInfo);
  }

  /**
   * Forwards an incident payload to the LangFlow webhook.
   */
  async forward(incident) {
    const eventId = incident.event_id;

    if (!this.forwardEnabled) {
      const statusInfo = {
        status: 'dry-run',
        lastAttempt: new Date().toISOString(),
        error: null,
        httpStatus: null,
        message: 'Forwarding disabled via FORWARD_ENABLED=false (Dry-Run)'
      };
      this.emitStatusChange(eventId, statusInfo);
      return { success: true, ...statusInfo };
    }

    if (!this.webhookUrl) {
      const statusInfo = {
        status: 'failed',
        lastAttempt: new Date().toISOString(),
        error: 'LANGFLOW_WEBHOOK_URL is not configured',
        httpStatus: null
      };
      this.emitStatusChange(eventId, statusInfo);
      this.outbox.enqueue(incident, statusInfo.error);
      return { success: false, ...statusInfo };
    }

    let attempt = 0;
    let lastError = null;

    while (attempt < this.maxRetries) {
      attempt++;
      this.emitStatusChange(eventId, {
        status: attempt === 1 ? 'forwarding' : 'retrying',
        attempts: attempt,
        lastAttempt: new Date().toISOString(),
        error: lastError ? lastError.message : null,
        httpStatus: null
      });

      try {
        const response = await this.sendHttpRequest(incident);
        const statusCode = response.status;

        // Treat 200, 201, 202 as successful acceptance
        if (statusCode >= 200 && statusCode <= 204) {
          const statusInfo = {
            status: 'forwarded',
            attempts: attempt,
            lastAttempt: new Date().toISOString(),
            error: null,
            httpStatus: statusCode,
            forwardedAt: new Date().toISOString()
          };
          this.emitStatusChange(eventId, statusInfo);
          this.outbox.remove(eventId);
          return { success: true, ...statusInfo };
        } else {
          const bodyText = await response.text().catch(() => '');
          lastError = new Error(
            `LangFlow webhook returned HTTP ${statusCode}: ${bodyText.slice(0, 200)}`
          );
        }
      } catch (err) {
        lastError = err;
      }

      // If not yet maxRetries, wait with exponential backoff
      if (attempt < this.maxRetries) {
        const backoffMs = Math.pow(2, attempt - 1) * this.retryDelayMs;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    // Retries exhausted, persist to outbox
    const failedInfo = {
      status: 'failed',
      attempts: attempt,
      lastAttempt: new Date().toISOString(),
      error: lastError ? lastError.message : 'Unknown network failure',
      httpStatus: null
    };
    this.emitStatusChange(eventId, failedInfo);
    this.outbox.enqueue(incident, failedInfo.error);
    return { success: false, ...failedInfo };
  }

  async sendHttpRequest(incident) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*'
    };

    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      return await fetch(this.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(incident),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async drainOutbox() {
    if (!this.forwardEnabled) return;
    const pending = this.outbox.getPending();
    if (pending.length === 0) return;

    const now = Date.now();
    for (const item of pending) {
      const nextTime = item.nextAttemptAt ? Date.parse(item.nextAttemptAt) : 0;
      if (now >= nextTime) {
        try {
          const res = await this.forward(item.incident);
          if (res.success) {
            console.log(`[Forwarder] Successfully delivered outbox incident: ${item.id}`);
          }
        } catch (err) {
          console.warn(`[Forwarder] Outbox redelivery attempt failed for ${item.id}:`, err.message);
        }
      }
    }
  }

  stop() {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
    }
  }
}

module.exports = IncidentForwarder;
