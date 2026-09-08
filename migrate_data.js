const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');
dotenv.config();

async function migrate() {
    const oldUri = process.env.MONGODB_URI;
    const newUri = process.env.RESIDENTS_DB_URI;

    if (!oldUri || !newUri) {
        console.error('Missing MONGODB_URI or RESIDENTS_DB_URI in .env');
        process.exit(1);
    }

    const oldClient = new MongoClient(oldUri);
    const newClient = new MongoClient(newUri);

    try {
        console.log('--- Starting Data Migration ---');

        await oldClient.connect();
        console.log('Connected to SOURCE database.');

        await newClient.connect();
        console.log('Connected to DESTINATION database.');

        const oldDb = oldClient.db(); // Gets DB from connection string (EcoWatchBackend1)
        const newDb = newClient.db(); // Gets DB from connection string (ResidentsDB)

        const collections = ['residents', 'reports', 'trashreports', 'archivedreports'];

        for (const collName of collections) {
            console.log(`Processing: ${collName}...`);
            const data = await oldDb.collection(collName).find({}).toArray();

            if (data.length > 0) {
                // Clear the new collection first
                await newDb.collection(collName).deleteMany({});
                // Insert the old data
                const result = await newDb.collection(collName).insertMany(data);
                console.log(`Success: Moved ${result.insertedCount} documents to ${collName}`);
            } else {
                console.log(`Skipped: ${collName} is empty in source.`);
            }
        }

        console.log('--- Migration Completed Successfully ---');
    } catch (err) {
        console.error('Migration failed with error:');
        console.error(err);
    } finally {
        await oldClient.close();
        await newClient.close();
        process.exit(0);
    }
}

migrate();
