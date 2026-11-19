const fs = require('fs');
const path = require('path');

class OutboxManager {
  constructor(filePath) {
    this.filePath = filePath;
    this.items = [];
    this.init();
  }

  init() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.items = JSON.parse(raw);
        if (!Array.isArray(this.items)) {
          this.items = [];
        }
      } else {
        this.items = [];
        this.save();
      }
    } catch (err) {
      console.warn(`[Outbox] Warning: Failed to initialize outbox from ${this.filePath}:`, err.message);
      this.items = [];
    }
  }

  save() {
    try {
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.items, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error(`[Outbox] Error saving outbox file:`, err.message);
    }
  }

  enqueue(incident, errorMsg = '') {
    const existingIndex = this.items.findIndex(
      (item) => item.incident.event_id === incident.event_id
    );

    const now = new Date().toISOString();
    if (existingIndex >= 0) {
      const existing = this.items[existingIndex];
      existing.attempts = (existing.attempts || 1) + 1;
      existing.lastAttemptAt = now;
      existing.lastError = errorMsg;
      // Exponential backoff calculation: min(300000, 2^(attempts-1) * 2000)
      const delayMs = Math.min(300000, Math.pow(2, existing.attempts) * 1000);
      existing.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    } else {
      this.items.push({
        id: incident.event_id,
        incident,
        attempts: 1,
        firstEnqueuedAt: now,
        lastAttemptAt: now,
        nextAttemptAt: new Date(Date.now() + 2000).toISOString(),
        lastError: errorMsg
      });
    }

    this.save();
  }

  remove(eventId) {
    const prevCount = this.items.length;
    this.items = this.items.filter((item) => item.id !== eventId && item.incident.event_id !== eventId);
    if (this.items.length !== prevCount) {
      this.save();
    }
  }

  getPending() {
    return [...this.items];
  }

  count() {
    return this.items.length;
  }
}

module.exports = OutboxManager;
