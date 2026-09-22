const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const options = {
  // Add any specific Mongoose options here if needed
};

const authConnection = mongoose.createConnection(process.env.MONGODB_URI, options);
const appConnection = mongoose.createConnection(process.env.RESIDENTS_DB_URI, options);
const adminConnection = mongoose.createConnection(process.env.ADMIN_DB_URI, options);

authConnection.on('connected', () => console.log('[DATABASE] Auth DB Connected'));
appConnection.on('connected', () => console.log('[DATABASE] App DB Connected'));
adminConnection.on('connected', () => console.log('[DATABASE] Admin DB Connected'));

authConnection.on('error', (err) => console.error(`[DATABASE] Auth DB Error: ${err}`));
appConnection.on('error', (err) => console.error(`[DATABASE] App DB Error: ${err}`));
adminConnection.on('error', (err) => console.error(`[DATABASE] Admin DB Error: ${err}`));

module.exports = {
  authConnection,
  appConnection,
  adminConnection
};
