const path = require('path');
const dotenv = require('dotenv');

// The application root directory (where package.json and .env reside)
const appRootDir = path.resolve(__dirname, '..');

// Load environment variables exclusively from the new app's own .env file
dotenv.config({ path: path.join(appRootDir, '.env') });

function resolveAppPath(relOrAbsPath, defaultPath) {
  const target = relOrAbsPath || defaultPath;
  if (!target) return '';
  return path.isAbsolute(target) ? target : path.resolve(appRootDir, target);
}

const config = {
  appRootDir,
  port: parseInt(process.env.PORT, 10) || 3001,
  pm2LogSource: resolveAppPath(
    process.env.PM2_LOG_SOURCE,
    '../LangFlow/runtime/pm2/button-demo-error.log'
  ),
  pm2OutLogSource: resolveAppPath(
    process.env.PM2_OUT_LOG_SOURCE,
    (process.env.PM2_LOG_SOURCE || '../LangFlow/runtime/pm2/button-demo-error.log').replace(/error\.log$/i, 'out.log')
  ),
  outLogStateFile: resolveAppPath(process.env.OUT_LOG_STATE_FILE, 'runtime/log-viewer-out-state.json'),
  langflowWebhookUrl:
    process.env.LANGFLOW_WEBHOOK_URL ||
    'http://localhost:7860/api/v1/webhook/incident_to_jira',
  langflowApiKey: process.env.LANGFLOW_API_KEY || '',
  logStateFile: resolveAppPath(
    process.env.LOG_STATE_FILE,
    'runtime/log-viewer-state.json'
  ),
  outboxFile: resolveAppPath(
    process.env.OUTBOX_FILE,
    'runtime/outbox.json'
  ),
  forwardEnabled: String(process.env.FORWARD_ENABLED).toLowerCase() === 'true',
  // Polling interval in ms for log file check
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS, 10) || 1000,
  // Max retries for webhook forwarder
  maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 3,
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS, 10) || 1000
};

module.exports = config;
