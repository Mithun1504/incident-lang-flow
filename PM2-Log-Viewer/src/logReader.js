const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { normalizeIncident } = require('./normalizer');

class PM2LogReader extends EventEmitter {
  constructor(config) {
    super();
    this.logSource = config.pm2LogSource;
    this.stateFile = config.logStateFile;
    this.pollIntervalMs = config.pollIntervalMs || 1000;
    
    this.lastByteOffset = 0;
    this.processedFingerprints = new Set();
    this.forwardedEventIds = new Set();
    this.logsCache = []; // In-memory cache of normalized incidents, newest first
    this.maxLogsCache = 500;

    this.isChecking = false;
    this.watcher = null;
    this.pollTimer = null;
    this.stateLoaded = false;
  }

  loadState() {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf8');
        const state = JSON.parse(raw);
        this.lastByteOffset = typeof state.lastByteOffset === 'number' ? state.lastByteOffset : 0;
        if (Array.isArray(state.processedFingerprints)) {
          this.processedFingerprints = new Set(state.processedFingerprints);
        }
        if (Array.isArray(state.forwardedEventIds)) {
          this.forwardedEventIds = new Set(state.forwardedEventIds);
        }
        this.stateLoaded = true;
        return true;
      }
    } catch (err) {
      console.warn(`[LogReader] Could not load state from ${this.stateFile}:`, err.message);
    }
    this.stateLoaded = false;
    return false;
  }

  saveState() {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Limit stored fingerprints to most recent 1000 to keep state file compact
      const fingerprintsArray = Array.from(this.processedFingerprints).slice(-1000);
      const forwardedArray = Array.from(this.forwardedEventIds).slice(-1000);

      const state = {
        lastByteOffset: this.lastByteOffset,
        processedFingerprints: fingerprintsArray,
        forwardedEventIds: forwardedArray,
        lastUpdated: new Date().toISOString()
      };

      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      console.error(`[LogReader] Error saving state file ${this.stateFile}:`, err.message);
    }
  }

  markForwarded(eventId) {
    this.forwardedEventIds.add(eventId);
    this.saveState();
  }

  /**
   * Initializes reader and performs the first read.
   * If state file did not exist, reads historical logs to populate UI (marked as existing),
   * and sets offset to current file size so historical logs are not re-forwarded.
   */
  start() {
    const hadExistingState = this.loadState();

    // Initial check
    this.checkFile(hadExistingState ? 'resume' : 'initial');

    // Setup periodic polling
    this.pollTimer = setInterval(() => {
      this.checkFile('poll');
    }, this.pollIntervalMs);
    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }

    // Setup file watcher if possible
    this.setupWatcher();
  }

  setupWatcher() {
    try {
      if (fs.existsSync(this.logSource)) {
        this.watcher = fs.watch(this.logSource, (eventType) => {
          if (eventType === 'change' || eventType === 'rename') {
            this.checkFile('watch');
          }
        });
        this.watcher.on('error', (err) => {
          console.warn('[LogReader] File watcher error:', err.message);
        });
      }
    } catch (err) {
      console.warn('[LogReader] Could not set up file watcher:', err.message);
    }
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Reads new lines from logSource
   */
  checkFile(trigger = 'manual') {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      if (!fs.existsSync(this.logSource)) {
        return;
      }

      // Re-setup watcher if not yet active
      if (!this.watcher) {
        this.setupWatcher();
      }

      const stats = fs.statSync(this.logSource);
      const currentSize = stats.size;

      // Handle log rotation or truncation
      if (currentSize < this.lastByteOffset) {
        console.log(`[LogReader] Log rotation or truncation detected (${currentSize} < ${this.lastByteOffset}). Resetting offset to 0.`);
        this.lastByteOffset = 0;
      }

      // First run without prior state: read existing logs for UI without forwarding
      if (trigger === 'initial') {
        if (currentSize > 0) {
          this.readSlice(0, currentSize, false);
          this.lastByteOffset = currentSize;
          this.saveState();
        }
        return;
      }

      // If resuming with prior state on server start:
      // First, read from 0 to lastByteOffset to populate UI history if empty
      if (trigger === 'resume' && this.logsCache.length === 0 && this.lastByteOffset > 0) {
        this.readSlice(0, Math.min(this.lastByteOffset, currentSize), false);
      }

      // Check if there are new bytes to read
      if (currentSize > this.lastByteOffset) {
        const start = this.lastByteOffset;
        this.readSlice(start, currentSize, true);
        this.saveState();
      }
    } catch (err) {
      console.error('[LogReader] Error reading log file:', err.message);
      this.emit('error', err);
    } finally {
      this.isChecking = false;
    }
  }

  readSlice(startByte, endByte, isNew = true) {
    const bytesToRead = endByte - startByte;
    if (bytesToRead <= 0) return;

    let fd;
    try {
      fd = fs.openSync(this.logSource, 'r');
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, startByte);

      const content = buffer.toString('utf8');

      // Find the last complete newline to prevent processing cut-off lines
      let lastNewline = content.lastIndexOf('\n');
      let processableContent;
      let actualBytesProcessed;

      if (lastNewline === -1) {
        // No complete line ended with \n yet in this chunk.
        // Wait for more data unless file reading reached end and file is not being written.
        if (isNew) {
          // Keep offset at startByte so next read retries this partial line
          return;
        }
        processableContent = content;
        actualBytesProcessed = bytesToRead;
      } else {
        processableContent = content.substring(0, lastNewline);
        // Include the newline character in the offset
        actualBytesProcessed = Buffer.byteLength(content.substring(0, lastNewline + 1), 'utf8');
      }

      const lines = processableContent.split(/\r?\n/);
      for (const line of lines) {
        this.processLine(line, isNew);
      }

      if (isNew) {
        this.lastByteOffset = startByte + actualBytesProcessed;
      }
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (_) {}
      }
    }
  }

  processLine(line, isNew) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      // Ignore non-JSON lines as required
      return;
    }

    // Process only entries where level is "error"
    if (!parsed || parsed.level !== 'error') {
      return;
    }

    const incident = normalizeIncident(parsed);

    // Track fingerprint
    const isFirstTimeSeen = !this.processedFingerprints.has(incident.fingerprint);
    this.processedFingerprints.add(incident.fingerprint);

    // Initial delivery status
    let initialStatus = 'received';
    if (!isNew) {
      // Historical log loaded from disk
      initialStatus = this.forwardedEventIds.has(incident.event_id)
        ? 'forwarded'
        : 'received';
    }

    const entry = {
      ...incident,
      deliveryStatus: initialStatus,
      isNew
    };

    // Prepend to logs cache (newest first)
    this.logsCache.unshift(entry);
    if (this.logsCache.length > this.maxLogsCache) {
      this.logsCache.pop();
    }

    this.emit('incident', entry, isNew);
  }

  getLogs() {
    return [...this.logsCache];
  }

  getLogByEventId(eventId) {
    return this.logsCache.find((l) => l.event_id === eventId || l.request_id === eventId);
  }

  updateDeliveryStatus(eventId, statusInfo) {
    const log = this.logsCache.find((l) => l.event_id === eventId);
    if (log) {
      log.deliveryStatus = statusInfo.status;
      log.deliveryDetails = statusInfo;
    }
    if (statusInfo.status === 'forwarded') {
      this.markForwarded(eventId);
    }
  }
}

module.exports = PM2LogReader;
