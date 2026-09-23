require("dotenv").config();

const dns = require("dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const { Pool } = require("pg");

const pgPool = new Pool({
    connectionString: process.env.SUPABASE_DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function migrateResidents() {
    const client = await pgPool.connect();

    try {
        // ==========================================
        // 1. CONNECT TO MONGODB
        // ==========================================

        console.log("Connecting to MongoDB...");

        await mongoose.connect(process.env.MONGODB_MIGRATION_URI, {
            dbName: "ResidentsDB"
        });

        console.log("✅ MongoDB connection successful!");

        // ==========================================
        // 2. READ RESIDENTS FROM MONGODB
        // ==========================================

        const residents = await mongoose.connection.db
            .collection("residents")
            .find({})
            .toArray();

        console.log(`\nFound ${residents.length} resident(s) in MongoDB.`);

        if (residents.length === 0) {
            console.log("No residents to migrate.");
            return;
        }

        // ==========================================
        // 3. BEGIN POSTGRESQL TRANSACTION
        // ==========================================

        await client.query("BEGIN");

        console.log("\nStarting Supabase migration...");

        let inserted = 0;
        let skipped = 0;

        // ==========================================
        // 4. MIGRATE EACH RESIDENT
        // ==========================================

        for (const resident of residents) {

            const result = await client.query(
                `
                INSERT INTO residents (
                    resident_id,
                    first_name,
                    last_name,
                    username,
                    email,
                    password_hash,
                    profile_image,
                    address,
                    is_verified,
                    created_at,
                    updated_at
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    $10,
                    $11
                )
                ON CONFLICT (resident_id) DO NOTHING
                RETURNING resident_id
                `,
                [
                    resident.residentId,
                    resident.firstName,
                    resident.lastName,
                    resident.username,
                    resident.email ?? null,
                    resident.password ?? null,
                    resident.profileImage ?? null,
                    resident.address ?? null,
                    resident.isVerified ?? false,
                    resident.createdAt ?? null,
                    resident.updatedAt ?? null
                ]
            );

            if (result.rowCount === 1) {
                inserted++;

                console.log(
                    `✅ Migrated: ${resident.residentId} (${resident.username})`
                );
            } else {
                skipped++;

                console.log(
                    `⏭️ Skipped: ${resident.residentId} already exists`
                );
            }
        }

        // ==========================================
        // 5. COMMIT
        // ==========================================

        await client.query("COMMIT");

        console.log("\n========================================");
        console.log("RESIDENT MIGRATION COMPLETE");
        console.log("========================================");
        console.log(`MongoDB records found : ${residents.length}`);
        console.log(`Inserted              : ${inserted}`);
        console.log(`Skipped               : ${skipped}`);
        console.log("========================================");

    } catch (error) {

        // ==========================================
        // ROLLBACK IF ANYTHING FAILS
        // ==========================================

        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            console.error("Rollback failed:", rollbackError.message);
        }

        console.error("\n❌ Resident migration failed!");
        console.error(error.message);

    } finally {

        await mongoose.disconnect();
        client.release();
        await pgPool.end();

        console.log("\nConnections closed.");
    }
}

migrateResidents();