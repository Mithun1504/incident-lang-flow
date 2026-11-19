const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env') });

module.exports = {
  apps: [
    {
      name: process.env.SERVICE_NAME || 'button-demo',
      script: './app/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      // Explicit separate normal and error log files
      error_file: path.resolve(__dirname, process.env.PM2_ERROR_LOG || 'runtime/pm2/button-demo-error.log'),
      out_file: path.resolve(__dirname, 'runtime/pm2/button-demo-out.log'),
      merge_logs: true,
      time: false, // Structured JSON already includes ISO timestamp
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        SERVICE_NAME: process.env.SERVICE_NAME || 'button-demo',
        ENVIRONMENT: process.env.ENVIRONMENT || 'local'
      }
    },
    {
      name: 'jira-pr-poller',
      script: './scripts/jira_pr_poller.cjs',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      error_file: path.resolve(__dirname, 'runtime/pm2/jira-pr-poller-error.log'),
      out_file: path.resolve(__dirname, 'runtime/pm2/jira-pr-poller-out.log'),
      time: true
    }
  ]
};
