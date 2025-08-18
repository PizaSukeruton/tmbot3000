// db/pool.js
const { Pool } = require('pg');
const os = require('os');
require('dotenv').config();

// Determine SSL needs:
// - Render typically requires SSL; local dev usually doesn't.
// - Respect explicit PGSSLMODE if provided.
function resolveSsl() {
  // If DATABASE_URL already encodes sslmode, pg will respect it.
  // But some hosts still need the object form; gate on NODE_ENV.
  const env = process.env.NODE_ENV || 'development';
  const explicit = process.env.PGSSLMODE?.toLowerCase();

  if (explicit === 'require' || explicit === 'no-verify') {
    return { rejectUnauthorized: explicit !== 'no-verify' };
  }

  if (env === 'production') {
    // Render/Cloud: enable SSL but allow self-signed certs
    return { rejectUnauthorized: false };
  }

  // Local/dev: no SSL by default
  return false;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSsl(),
  // Pool tuning — adjust if needed
  max: Number(process.env.PG_POOL_MAX || 10),                 // max concurrent clients
  idleTimeoutMillis: Number(process.env.PG_IDLE_MS || 30000), // close idle clients after 30s
  connectionTimeoutMillis: Number(process.env.PG_CONN_MS || 5000), // fail fast on connect
  statement_timeout: Number(process.env.PG_STATEMENT_MS || 30000), // server-side timeout
  query_timeout: Number(process.env.PG_QUERY_MS || 30000),    // client-side timeout
  application_name: process.env.PG_APP_NAME || `tmbot3000:${os.hostname()}`,
});

// Helpful diagnostics (optional; keep concise in prod)
pool.on('error', (err) => {
  console.error('[pg] Unexpected error on idle client:', err);
});

// Optionally verify connectivity at startup (non-fatal if you prefer)
async function verifyOnce() {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
  } catch (err) {
    console.error('[pg] Initial connectivity check failed:', err.message);
  }
}
verifyOnce().catch(() => { /* no-op */ });

// Graceful shutdown
function shutdown() {
  pool.end()
    .then(() => {
      // console.log('[pg] Pool closed');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[pg] Error closing pool:', err);
      process.exit(1);
    });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

module.exports = pool;
