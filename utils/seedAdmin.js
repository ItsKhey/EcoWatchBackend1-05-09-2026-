const Resident = require('../models/Resident');
const { generateResidentId } = require('./generateId');

const seedAdmin = async () => {
  try {
    const adminExists = await Resident.findOne({ role: 'ADMIN' });

    if (!adminExists) {
      console.log('[SEED] No admin found. Creating default admin account...');

      const admin = await Resident.create({
        residentId: generateResidentId(),
        firstName: 'Cenro',
        lastName: 'Admin',
        username: 'admin',
        email: 'admin@ecowatch.com',
        password: 'adminpassword123', // Admin should change this after first login
        role: 'ADMIN',
        isVerified: true,
      });

      console.log(`[SEED] Default admin created: ${admin.username}`);
    } else {
      console.log(`[SEED] Admin account already exists: ${adminExists.username}`);
    }
  } catch (error) {
    console.error(`[SEED] Error seeding admin: ${error.message}`);
  }
};

module.exports = seedAdmin;
