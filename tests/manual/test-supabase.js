require("dotenv").config();

const { poolOptions, describeTarget, resolveConnectionString } = require('../../src/config/database');

const { Pool } = require("pg");

const pool = new Pool(poolOptions());

async function testConnection() {
    const target = describeTarget(resolveConnectionString());

    try {
        const result = await pool.query("SELECT NOW() AS current_time");

        console.log(`✅ ${target.label} connection successful! (${target.host})`);
        console.log("Database time:", result.rows[0].current_time);
    } catch (error) {
        console.error(`❌ ${target.label} connection failed! (${target.host})`);
        console.error(error.message);
    } finally {
        await pool.end();
    }
}

testConnection();