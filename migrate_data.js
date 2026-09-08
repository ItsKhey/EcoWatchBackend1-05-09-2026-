const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const migrate = async () => {
  try {
    console.log('--- Starting Data Migration ---');

    // Connect to Old DB (EcoWatchBackend1)
    const oldConn = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
    console.log('Connected to OLD Database');

    // Connect to New DB (ResidentsDB)
    const newConn = await mongoose.createConnection(process.env.RESIDENTS_DB_URI).asPromise();
    console.log('Connected to NEW Database');

    const collectionsToMigrate = ['residents', 'reports', 'trashreports', 'archivedreports'];

    for (const collName of collectionsToMigrate) {
      console.log(`Migrating collection: ${collName}...`);

      const oldColl = oldConn.collection(collName);
      const newColl = newConn.collection(collName);

      const data = await oldColl.find({}).toArray();

      if (data.length > 0) {
        // Clear new collection first to avoid duplicates if re-run
        await newColl.deleteMany({});
        await newColl.insertMany(data);
        console.log(`Successfully moved ${data.length} documents to ${collName}`);
      } else {
        console.log(`Collection ${collName} was empty in old DB.`);
      }
    }

    console.log('--- Migration Completed Successfully ---');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
};

migrate();
