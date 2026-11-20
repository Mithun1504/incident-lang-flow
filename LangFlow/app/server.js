const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const data = require('./data');

const appRoot = fs.existsSync(path.join(__dirname, 'package.json')) ? __dirname : path.resolve(__dirname, '..');
dotenv.config({ path: path.join(appRoot, '.env') });
const app = express();
const SERVICE_NAME = process.env.SERVICE_NAME || 'button-demo';
const ENVIRONMENT = process.env.ENVIRONMENT || 'local';

// One completion log per API request, with the same contract for every result.
// PM2 captures successful activity in stdout and failures in stderr.
app.use('/api', (req, res, next) => {
  const started = process.hrtime.bigint();
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  res.on('finish', () => {
    const error = res.locals.error;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    const entry = {
      level, service: SERVICE_NAME, environment: ENVIRONMENT,
      method: req.method, route: req.originalUrl.split('?')[0],
      status_code: res.statusCode,
      duration_ms: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2)),
      message: error?.message || `${req.method} ${req.originalUrl.split('?')[0]} completed`,
      ...(error ? { error_type: error.name, stack_trace: error.stack } : {}),
      request_id: req.id, timestamp: new Date().toISOString()
    };
    (level === 'error' ? console.error : console.log)(JSON.stringify(entry));
  });
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));
const reply = (req, res, payload) => res.json({ ...payload, request_id: req.id, timestamp: new Date().toISOString() });

app.get('/api/health', (req, res) => reply(req, res, { status: 'ok', service: SERVICE_NAME, environment: ENVIRONMENT }));
app.get('/api/dashboard', (req, res) => reply(req, res, { profile: data.profile, projects: data.projects.slice(0, 3), tasks: data.tasks, activity: data.activity, stats: { activeProjects: data.projects.filter(p => p.status !== 'Completed').length, completedTasks: 57, teamMembers: data.team.length, upcomingDeadlines: 3 } }));
app.get('/api/my-profile', (req, res) => reply(req, res, { profile: data.profile }));
app.get('/api/projects', (req, res) => reply(req, res, { projects: data.projects }));
app.get('/api/team', (req, res) => reply(req, res, { members: data.team }));
app.get('/api/settings', (req, res) => reply(req, res, { settings: data.settings }));
app.patch('/api/my-profile', (req, res) => {
  for (const key of ['name', 'title', 'phone', 'location', 'bio']) {
    if (typeof req.body?.[key] === 'string') data.profile[key] = req.body[key].trim().slice(0, 300);
  }
  reply(req, res, { profile: data.profile, message: 'Profile updated for this session.' });
});
app.put('/api/settings', (req, res) => {
  for (const key of ['weeklyDigest', 'projectUpdates', 'taskReminders']) {
    if (typeof req.body?.[key] === 'boolean') data.settings[key] = req.body[key];
  }
  reply(req, res, { settings: data.settings, message: 'Preferences saved for this session.' });
});

function fail(req, res, name, message, status = 500) {
  const error = new Error(message);
  error.name = name;
  res.locals.error = error;
  res.status(status).json({ status: 'error', error_type: name, message, request_id: req.id, timestamp: new Date().toISOString() });
}
app.post('/api/simulate-failure', (req, res) => fail(req, res, 'ServiceUnavailableError', 'The reporting service is temporarily unavailable. Please try again later.', 503));
// Keep the original endpoints for existing teaching branches and integrations.
app.post('/api/fail-one', (req, res) => fail(req, res, 'IntentionalPrototypeError', 'Test failure from button one'));
app.post('/api/fail-two', (req, res) => fail(req, res, 'IntentionalPrototypeError', 'Test failure from button two: database connection simulated timeout'));
for (const color of ['red', 'blue']) app.post(`/api/success-${color}`, (req, res) => reply(req, res, { status: 'success', message: 'Action completed successfully.' }));
app.use('/api', (req, res) => res.status(404).json({ message: 'This endpoint does not exist.', request_id: req.id }));
app.get(['/', '/dashboard', '/my-profile', '/projects', '/team', '/settings'], (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.locals.error = error;
  res.status(error.status || 500).json({ message: error.status === 400 ? 'Please provide valid JSON.' : 'The request could not be completed.', request_id: req.id });
});

function startServer(port = process.env.PORT || 3000) {
  return app.listen(port, () => console.log(`[${SERVICE_NAME}] Workspace running on http://localhost:${port}`));
}
if (require.main === module) startServer();
module.exports = { app, startServer };
