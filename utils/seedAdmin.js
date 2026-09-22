const Admin = require('../models/Admin');
const Resident = require('../models/Resident');
const { appConnection } = require('../config/db');
const { generateResidentId } = require('./generateId');

const seedAdmin = async () => {
  try {
    // 1. Check for admins in OLD locations (residents collection OR adminDB collection in ResidentsDB)
    const oldAdmins = await Resident.find({ role: 'ADMIN' });
    const oldAdminDB = appConnection.collection('adminDB');
    const partiallyMigrated = await oldAdminDB.find({}).toArray();

    const migrationQueue = [...oldAdmins.map(a => a.toObject()), ...partiallyMigrated];

    if (migrationQueue.length > 0) {
      console.log(`[MIGRATION] Found ${migrationQueue.length} admins to move to the dedicated AdminDB database...`);
      for (const adminData of migrationQueue) {
        const exists = await Admin.findOne({ username: adminData.username });
        if (!exists) {
          await Admin.create(adminData);
          console.log(`[MIGRATION] Successfully moved admin '${adminData.username}' to AdminDB.`);
        }
      }
      // Cleanup
      await Resident.deleteMany({ role: 'ADMIN' });
      await oldAdminDB.deleteMany({});
      console.log(`[MIGRATION] Cleanup of old database locations complete.`);
    }

    const adminExists = await Admin.findOne({ role: 'ADMIN' });

    if (!adminExists) {
      console.log('[SEED] No admin found in AdminDB. Creating default admin account...');
      await Admin.create({
        residentId: generateResidentId(),
        firstName: 'Cenro',
        lastName: 'Admin',
        username: 'admin',
        email: 'admin@ecowatch.com',
        password: 'adminpassword123',
        role: 'ADMIN',
        isVerified: true,
      });
      console.log(`[SEED] Default admin created in AdminDB.`);
    } else {
      console.log(`[SEED] Admin account verified in AdminDB: ${adminExists.username}`);
    }
  } catch (error) {
    console.error(`[SEED] Error during admin management: ${error.message}`);
  }
};

module.exports = seedAdmin;
