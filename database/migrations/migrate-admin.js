require("dotenv").config();

const { poolOptions } = require('../../src/config/database');

const dns = require("dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const { Pool } = require("pg");

const pgPool = new Pool(poolOptions());

async function migrateAdmin() {
    const client = await pgPool.connect();

    try {
        // ==========================================
        // 1. CONNECT TO MONGODB
        // ==========================================

        console.log("Connecting to MongoDB...");

        await mongoose.connect(process.env.MONGODB_MIGRATION_URI, {
            dbName: "AdminDB"
        });

        console.log("✅ MongoDB connection successful!");

        // ==========================================
        // 2. READ ADMIN FROM MONGODB
        // ==========================================

        const admins = await mongoose.connection.db
            .collection("adminDB")
            .find({})
            .toArray();

        console.log(`\nFound ${admins.length} admin record(s).`);

        if (admins.length === 0) {
            console.log("No admin records to migrate.");
            return;
        }

        // ==========================================
        // 3. BEGIN TRANSACTION
        // ==========================================

        await client.query("BEGIN");

        console.log("\nStarting Supabase admin migration...");

        let inserted = 0;
        let skipped = 0;

        // ==========================================
        // 4. MIGRATE ADMIN
        // ==========================================

        for (const admin of admins) {

            const result = await client.query(
                `
                INSERT INTO admins (
                    admin_id,
                    first_name,
                    last_name,
                    username,
                    email,
                    password_hash,
                    address,
                    profile_image,
                    is_verified,
                    role,
                    phone_number,
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
                    $11,
                    $12,
                    $13
                )
                ON CONFLICT (admin_id) DO NOTHING
                RETURNING admin_id
                `,
                [
                    typeof admin.residentId === "string" && admin.residentId.startsWith("RES-")
                        ? admin.residentId.replace(/^RES-/, "ADM-")
                        : admin.residentId,
                    admin.firstName,
                    admin.lastName,
                    admin.username,
                    admin.email ?? null,
                    admin.password ?? null,
                    admin.address ?? null,
                    admin.profileImage ?? null,
                    admin.isVerified ?? false,
                    admin.role ?? null,
                    admin.phoneNumber ?? null,
                    admin.createdAt ?? null,
                    admin.updatedAt ?? null
                ]
            );

            if (result.rowCount === 1) {
                inserted++;

                console.log(
                    `✅ Migrated admin: ${admin.residentId} (${admin.username})`
                );
            } else {
                skipped++;

                console.log(
                    `⏭️ Skipped admin: ${admin.residentId} already exists`
                );
            }
        }

        // ==========================================
        // 5. COMMIT
        // ==========================================

        await client.query("COMMIT");

        console.log("\n========================================");
        console.log("ADMIN MIGRATION COMPLETE");
        console.log("========================================");
        console.log(`MongoDB records found : ${admins.length}`);
        console.log(`Inserted              : ${inserted}`);
        console.log(`Skipped               : ${skipped}`);
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

        console.error("\n❌ Admin migration failed!");
        console.error(error.message);

    } finally {

        await mongoose.disconnect();
        client.release();
        await pgPool.end();

        console.log("\nConnections closed.");
    }
}

migrateAdmin();