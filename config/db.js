const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const options = {
  // Add any specific Mongoose options here if needed
};

const authUri = process.env.MONGODB_URI;
const appUri = process.env.RESIDENTS_DB_URI || authUri;
const adminUri = process.env.ADMIN_DB_URI || appUri || authUri;

if (!process.env.ADMIN_DB_URI) {
  console.warn('[DATABASE WARNING] ADMIN_DB_URI is missing from environment variables! Falling back to available database URI.');
}

const authConnection = mongoose.createConnection(authUri, options);
const appConnection = mongoose.createConnection(appUri, options);
const adminConnection = mongoose.createConnection(adminUri, options);

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
