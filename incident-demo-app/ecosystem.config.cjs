const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env') });

module.exports = {
  apps: [
    {
      name: 'incident-demo-app',
      script: './server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      error_file: path.resolve(__dirname, process.env.PM2_ERROR_LOG || 'runtime/pm2/incident-demo-error.log'),
      out_file: path.resolve(__dirname, 'runtime/pm2/incident-demo-out.log'),
      merge_logs: true,
      time: false,
      env: {
        NODE_ENV: 'development',
        PORT: process.env.PORT || 3000,
        SERVICE_NAME: process.env.SERVICE_NAME || 'incident-demo-app',
        ENVIRONMENT: process.env.ENVIRONMENT || 'local'
      }
    }
  ]
};
