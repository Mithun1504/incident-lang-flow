const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env') });
process.env.PM2_HOME = path.resolve(__dirname, 'runtime/.pm2');

require('./node_modules/pm2/bin/pm2');
