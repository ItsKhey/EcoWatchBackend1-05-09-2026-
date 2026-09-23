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

async function migrateHistories() {
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
        // 2. READ HISTORIES
        // ==========================================

        const histories = await mongoose.connection.db
            .collection("histories")
            .find({})
            .toArray();

        console.log(`\nFound ${histories.length} history record(s).`);

        if (histories.length === 0) {
            console.log("No histories to migrate.");
            return;
        }

        // ==========================================
        // 3. BEGIN TRANSACTION
        // ==========================================

        await client.query("BEGIN");

        console.log("\nStarting Supabase history migration...");

        let inserted = 0;

        // ==========================================
        // 4. MIGRATE HISTORIES
        // ==========================================

        for (const history of histories) {

            await client.query(
                `
                INSERT INTO report_histories (
                    resident_id,
                    report_id,
                    action,
                    old_status,
                    new_status,
                    description,
                    is_deleted,
                    deleted_at,
                    timestamp,
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
                `,
                [
                    history.residentId ?? null,
                    history.reportId ?? null,
                    history.action ?? null,
                    history.oldStatus ?? null,
                    history.newStatus ?? null,
                    history.description ?? null,
                    history.isDeleted ?? false,
                    history.deletedAt ?? null,
                    history.timestamp ?? null,
                    history.createdAt ?? null,
                    history.updatedAt ?? null
                ]
            );

            inserted++;

            console.log(
                `✅ Migrated history ${inserted}: report ${history.reportId}`
            );
        }

        // ==========================================
        // 5. COMMIT
        // ==========================================

        await client.query("COMMIT");

        console.log("\n========================================");
        console.log("HISTORY MIGRATION COMPLETE");
        console.log("========================================");
        console.log(`MongoDB records found : ${histories.length}`);
        console.log(`Inserted              : ${inserted}`);
        console.log("========================================");

    } catch (error) {

        // ==========================================
        // ROLLBACK
        // ==========================================

        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            console.error("Rollback failed:", rollbackError.message);
        }

        console.error("\n❌ History migration failed!");
        console.error(error.message);

    } finally {

        await mongoose.disconnect();
        client.release();
        await pgPool.end();

        console.log("\nConnections closed.");
    }
}

migrateHistories();