require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.SUPABASE_DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function testConnection() {
    try {
        const result = await pool.query("SELECT NOW() AS current_time");

        console.log("✅ Supabase PostgreSQL connection successful!");
        console.log("Database time:", result.rows[0].current_time);
    } catch (error) {
        console.error("❌ Supabase PostgreSQL connection failed!");
        console.error(error.message);
    } finally {
        await pool.end();
    }
}

testConnection();