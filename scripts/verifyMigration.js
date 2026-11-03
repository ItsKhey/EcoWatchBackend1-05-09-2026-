const dns = require('dns');

dns.setServers(['1.1.1.1', '1.0.0.1']);

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const { appConnection } = require('../src/config/db');
const Resident = require('../models/Resident');
const Admin = require('../models/Admin');

async function verify() {
  console.log('--- Verification Started ---');
  try {
    const residentAdmins = await Resident.find({ role: 'ADMIN' });
    const adminDBEntries = await Admin.find({});

    console.log(`Admins in 'residents' collection: ${residentAdmins.length}`);
    residentAdmins.forEach(a => console.log(` - Username: ${a.username}`));

    console.log(`Entries in 'adminDB' collection: ${adminDBEntries.length}`);
    adminDBEntries.forEach(a => console.log(` - Username: ${a.username} (Role: ${a.role})`));

    if (adminDBEntries.length > 0) {
      console.log('\nSUCCESS: Admin data is in the new collection.');
    } else if (residentAdmins.length > 0) {
        console.log('\nSTILL PENDING: Admin data is still in the old collection.');
    } else {
        console.log('\nNOT FOUND: No admin found in either collection. Check if the database name/URI is correct.');
    }

  } catch (err) {
    console.error('Verification failed:', err);
  } finally {
    mongoose.disconnect();
    process.exit(0);
  }
}

appConnection.on('connected', () => {
  verify();
});
