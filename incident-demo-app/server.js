const express = require('express');
const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from parent directory if present, else local
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SERVICE_NAME = process.env.SERVICE_NAME || 'button-demo';
const ENVIRONMENT = process.env.ENVIRONMENT || 'local';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to assign a unique request_id to each incoming request
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: SERVICE_NAME,
    environment: ENVIRONMENT,
    request_id: req.id,
    timestamp: new Date().toISOString()
  });
});

// Successful button 1 -> changes page color to red
app.post('/api/success-red', (req, res) => {
  res.status(200).json({
    status: 'success',
    color: 'red',
    message: 'Action completed successfully. Color changes to red.',
    request_id: req.id,
    timestamp: new Date().toISOString()
  });
});

// Successful button 2 -> changes page color to blue
app.post('/api/success-blue', (req, res) => {
  res.status(200).json({
    status: 'success',
    color: 'blue',
    message: 'Action completed successfully. Color changes to blue.',
    request_id: req.id,
    timestamp: new Date().toISOString()
  });
});

// Button 1 now handles the invalid demo action without an unhandled exception.
// It remains non-200 so the UI does not change color, but it no longer emits
// an IntentionalPrototypeError into PM2.
app.post('/api/fail-one', (req, res) => {
  res.status(400).json({
    status: 'rejected',
    error_type: 'HandledValidationError',
    message: 'The demo action was rejected by validation.',
    handled: true,
    request_id: req.id,
    timestamp: new Date().toISOString()
  });
});

// Failing button 2 -> Intentional backend failure 2
app.post('/api/fail-two', (req, res) => {
  const errorObj = new Error('Test failure from button two: database connection simulated timeout');
  errorObj.name = 'IntentionalPrototypeError';

  const logPayload = {
    level: 'error',
    service: SERVICE_NAME,
    environment: ENVIRONMENT,
    route: '/api/fail-two',
    error_type: errorObj.name,
    message: errorObj.message,
    stack_trace: errorObj.stack,
    request_id: req.id,
    timestamp: new Date().toISOString()
  };

  // Write exact single-line JSON log to stderr for PM2 to capture
  console.error(JSON.stringify(logPayload));

  res.status(500).json({
    status: 'error',
    error_type: errorObj.name,
    message: errorObj.message,
    request_id: req.id,
    timestamp: logPayload.timestamp
  });
});

app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] Server running on http://localhost:${PORT} in ${ENVIRONMENT} mode`);
});
