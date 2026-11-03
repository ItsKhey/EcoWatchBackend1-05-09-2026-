require("dotenv").config();

const { poolOptions } = require('../../src/config/database');

const dns = require("dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const { Pool } = require("pg");

const pgPool = new Pool(poolOptions());

async function migrateReports() {
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
        // 2. READ REPORTS
        // ==========================================

        const reports = await mongoose.connection.db
            .collection("reports")
            .find({})
            .toArray();

        console.log(`\nFound ${reports.length} report(s).`);

        if (reports.length === 0) {
            console.log("No reports to migrate.");
            return;
        }

        // ==========================================
        // 3. BEGIN TRANSACTION
        // ==========================================

        await client.query("BEGIN");

        console.log("\nStarting Supabase report migration...");

        let inserted = 0;
        let skipped = 0;

        // ==========================================
        // 4. MIGRATE REPORTS
        // ==========================================

        for (const report of reports) {

            const result = await client.query(
                `
                INSERT INTO reports (
                    report_id,
                    resident_id,
                    title,
                    category,
                    description,
                    latitude,
                    longitude,
                    image_url,
                    status,
                    admin_response,
                    assigned_personnel_ids,
                    priority,
                    is_deleted,
                    deleted_at,
                    is_archived,
                    is_restored,
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
                    $13,
                    $14,
                    $15,
                    $16,
                    $17,
                    $18
                )
                ON CONFLICT (report_id) DO NOTHING
                RETURNING report_id
                `,
                [
                    report.reportId,
                    report.residentId,
                    report.title ?? null,
                    report.category ?? null,
                    report.description ?? null,
                    report.latitude ?? null,
                    report.longitude ?? null,
                    report.imageUrl ?? null,
                    report.status ?? "Pending",
                    report.adminResponse ?? null,
                    Array.isArray(report.assignedPersonnelIds)
                        ? report.assignedPersonnelIds
                        : null,
                    report.priority ?? null,
                    report.isDeleted ?? false,
                    report.deletedAt ?? null,
                    report.isArchived ?? false,
                    report.isRestored ?? false,
                    report.createdAt ?? null,
                    report.updatedAt ?? null
                ]
            );

            if (result.rowCount === 1) {
                inserted++;

                console.log(
                    `✅ Migrated report: ${report.reportId}`
                );
            } else {
                skipped++;

                console.log(
                    `⏭️ Skipped report: ${report.reportId} already exists`
                );
            }
        }

        // ==========================================
        // 5. COMMIT
        // ==========================================

        await client.query("COMMIT");

        console.log("\n========================================");
        console.log("REPORT MIGRATION COMPLETE");
        console.log("========================================");
        console.log(`MongoDB records found : ${reports.length}`);
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

        console.error("\n❌ Report migration failed!");
        console.error(error.message);

    } finally {

        await mongoose.disconnect();
        client.release();
        await pgPool.end();

        console.log("\nConnections closed.");
    }
}

migrateReports();