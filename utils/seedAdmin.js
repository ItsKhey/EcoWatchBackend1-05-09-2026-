const Admin = require('../models/Admin');
const Resident = require('../models/Resident');
const { generateResidentId } = require('./generateId');

const seedAdmin = async () => {
  try {
    // Check if there are admins in the OLD collection to migrate
    const oldAdmins = await Resident.find({ role: 'ADMIN' });
    if (oldAdmins.length > 0) {
      console.log(`[MIGRATION] Found ${oldAdmins.length} admins in 'residents' collection. Moving to 'adminDB'...`);
      for (const admin of oldAdmins) {
        const adminData = admin.toObject();
        // Check if already in new collection
        const exists = await Admin.findOne({ username: adminData.username });
        if (!exists) {
          await Admin.create(adminData);
          console.log(`[MIGRATION] Moved admin: ${adminData.username}`);
        }
      }
      // Remove them from the old collection
      const deleteResult = await Resident.deleteMany({ role: 'ADMIN' });
      console.log(`[MIGRATION] Deleted ${deleteResult.deletedCount} admins from 'residents' collection.`);
    }

    const adminExists = await Admin.findOne({ role: 'ADMIN' });

    if (!adminExists) {
      console.log('[SEED] No admin found in adminDB. Creating default admin account...');

      const admin = await Admin.create({
        residentId: generateResidentId(),
        firstName: 'Cenro',
        lastName: 'Admin',
        username: 'admin',
        email: 'admin@ecowatch.com',
        password: 'adminpassword123', // Admin should change this after first login
        role: 'ADMIN',
        isVerified: true,
      });

      console.log(`[SEED] Default admin created in adminDB: ${admin.username}`);
    } else {
      console.log(`[SEED] Admin account already exists in adminDB: ${adminExists.username}`);
    }
  } catch (error) {
    console.error(`[SEED] Error seeding admin: ${error.message}`);
  }
};

module.exports = seedAdmin;
