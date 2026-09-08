const { MongoClient } = require('mongodb');
const dns = require('dns');
const dotenv = require('dotenv');
dotenv.config();

// FORCE the script to use Google's DNS to bypass your network's SRV block
dns.setServers(['8.8.8.8', '8.8.4.4']);

async function migrate() {
    const oldUri = process.env.MONGODB_URI;
    const newUri = process.env.RESIDENTS_DB_URI;

    if (!oldUri || !newUri) {
        console.error('Missing MONGODB_URI or RESIDENTS_DB_URI in .env');
        process.exit(1);
    }

    // Add connectTimeoutMS to give it more time on slow networks
    const options = {
        connectTimeoutMS: 30000,
        serverSelectionTimeoutMS: 30000
    };

    const oldClient = new MongoClient(oldUri, options);
    const newClient = new MongoClient(newUri, options);

    try {
        console.log('--- Starting Data Migration (Using Google DNS) ---');

        console.log('Connecting to SOURCE database...');
        await oldClient.connect();
        console.log('Connected to SOURCE.');

        console.log('Connecting to DESTINATION database...');
        await newClient.connect();
        console.log('Connected to DESTINATION.');

        const oldDb = oldClient.db();
        const newDb = newClient.db();

        const collections = ['residents', 'reports', 'trashreports', 'archivedreports'];

        for (const collName of collections) {
            console.log(`Processing: ${collName}...`);
            const data = await oldDb.collection(collName).find({}).toArray();

            if (data.length > 0) {
                await newDb.collection(collName).deleteMany({});
                const result = await newDb.collection(collName).insertMany(data);
                console.log(`Success: Moved ${result.insertedCount} documents to ${collName}`);
            } else {
                console.log(`Skipped: ${collName} is empty in source.`);
            }
        }

        console.log('--- Migration Completed Successfully ---');
    } catch (err) {
        console.error('Migration failed with error:');
        console.error(err.message);
        if (err.message.includes('ECONNREFUSED')) {
            console.log('\nTIP: Your network is still blocking the connection. Please try connecting your computer to a MOBILE HOTSPOT and run this script again.');
        }
    } finally {
        await oldClient.close();
        await newClient.close();
        process.exit(0);
    }
}

migrate();
