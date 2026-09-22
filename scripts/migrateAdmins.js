const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars from parent directory
dotenv.config({ path: path.join(__dirname, '../.env') });

const { appConnection } = require('../config/db');
const Resident = require('../models/Resident');
const Admin = require('../models/Admin');

async function migrate() {
  console.log('Starting Admin Migration...');

  try {
    // 1. Find all admins in the Resident collection
    const admins = await Resident.find({ role: 'ADMIN' });
    console.log(`Found ${admins.length} admins in 'residents' collection.`);

    if (admins.length === 0) {
      console.log('No admins to migrate.');
      process.exit(0);
    }

    // 2. Prepare data for the new adminDB collection
    const adminDocs = admins.map(admin => {
      const doc = admin.toObject();
      delete doc._id; // Let Mongo generate new _id or keep it?
      // Keeping same _id might be better for refs, but some drivers don't like it across collections.
      // However, residentId is our primary link.
      return doc;
    });

    // 3. Insert into adminDB
    // Note: Admin model is already configured to use collection 'adminDB'
    const insertResult = await Admin.insertMany(admins.map(a => a.toObject()));
    console.log(`Successfully inserted ${insertResult.length} admins into 'adminDB' collection.`);

    // 4. Delete from Resident collection
    const deleteResult = await Resident.deleteMany({ role: 'ADMIN' });
    console.log(`Successfully deleted ${deleteResult.deletedCount} admins from 'residents' collection.`);

    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    mongoose.disconnect();
    process.exit(0);
  }
}

// Wait for connection to be ready
appConnection.on('connected', () => {
  migrate();
});
