const dns = require('dns');

dns.setServers(['1.1.1.1', '1.0.0.1']);

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars from parent directory
dotenv.config({ path: path.join(__dirname, '../.env') });

const { appConnection, adminConnection } = require('../src/config/db');
const Resident = require('../models/Resident');
const Admin = require('../models/Admin');

async function migrate() {
  console.log('Starting Final Cross-Database Migration...');

  try {
    // 1. Check if admin is still in the Residents collection
    let admins = await Resident.find({ role: 'ADMIN' });

    // 2. Also check if they are in the 'adminDB' collection inside ResidentsDB (from previous attempt)
    // We can use a raw collection access since we changed the Admin model connection already
    const oldAdminDB = appConnection.collection('adminDB');
    const partiallyMigrated = await oldAdminDB.find({}).toArray();

    const allAdmins = [...admins.map(a => a.toObject()), ...partiallyMigrated];
    console.log(`Found ${allAdmins.length} admin(s) to move to AdminDB.`);

    if (allAdmins.length === 0) {
      console.log('No admins found in ResidentsDB to migrate.');
      process.exit(0);
    }

    // 3. Insert into the NEW AdminDB
    for (const adminData of allAdmins) {
      // Use Admin model (which is now on adminConnection/AdminDB)
      const exists = await Admin.findOne({ username: adminData.username });
      if (!exists) {
        await Admin.create(adminData);
        console.log(`Successfully moved admin '${adminData.username}' to AdminDB.`);
      } else {
        console.log(`Admin '${adminData.username}' already exists in AdminDB.`);
      }
    }

    // 4. Cleanup old locations
    await Resident.deleteMany({ role: 'ADMIN' });
    await oldAdminDB.deleteMany({});

    console.log('Migration to AdminDB completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    mongoose.disconnect();
    process.exit(0);
  }
}

// Wait for both connections
let connectedCount = 0;
const checkReady = () => {
    connectedCount++;
    if (connectedCount === 2) migrate();
};
appConnection.on('connected', checkReady);
adminConnection.on('connected', checkReady);
