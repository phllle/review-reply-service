import pg from "pg";

const { Pool } = pg;

let pool = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

/** Create tables if they don't exist. Call once at startup when using DB. */
export async function init() {
  const client = getPool();
  await client.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      account_id TEXT PRIMARY KEY,
      data JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS businesses (
      account_id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      name TEXT,
      contact TEXT,
      auto_reply_enabled BOOLEAN NOT NULL DEFAULT false,
      interval_minutes INTEGER NOT NULL DEFAULT 30,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auto_state (
      account_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      replied_review_ids JSONB NOT NULL DEFAULT '[]',
      PRIMARY KEY (account_id, location_id)
    );
  `);
}

// --- Tokens (keyed by accountId) ---

export async function getTokens() {
  const res = await getPool().query("SELECT account_id, data FROM tokens");
  const out = {};
  for (const row of res.rows) {
    out[row.account_id] = row.data;
  }
  return out;
}

export async function writeTokens(data) {
  const client = getPool();
  await client.query("DELETE FROM tokens");
  for (const [accountId, tokenData] of Object.entries(data)) {
    if (tokenData && (tokenData.refresh_token || tokenData.access_token)) {
      await client.query(
        "INSERT INTO tokens (account_id, data) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET data = $2",
        [accountId, JSON.stringify(tokenData)]
      );
    }
  }
}

// --- Businesses ---

export async function getAllBusinessesFromDb() {
  const res = await getPool().query(
    "SELECT account_id, location_id, name, contact, auto_reply_enabled, interval_minutes, updated_at FROM businesses"
  );
  const out = {};
  for (const row of res.rows) {
    out[row.account_id] = {
      accountId: row.account_id,
      locationId: row.location_id,
      name: row.name,
      contact: row.contact,
      autoReplyEnabled: row.auto_reply_enabled,
      intervalMinutes: row.interval_minutes,
      updatedAt: row.updated_at
    };
  }
  return out;
}

export async function getBusinessFromDb(accountId) {
  const res = await getPool().query(
    "SELECT account_id, location_id, name, contact, auto_reply_enabled, interval_minutes, updated_at FROM businesses WHERE account_id = $1",
    [accountId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    accountId: row.account_id,
    locationId: row.location_id,
    name: row.name,
    contact: row.contact,
    autoReplyEnabled: row.auto_reply_enabled,
    intervalMinutes: row.interval_minutes,
    updatedAt: row.updated_at
  };
}

export async function upsertBusinessInDb(config) {
  const now = new Date().toISOString();
  const existing = await getBusinessFromDb(config.accountId);
  const row = {
    account_id: config.accountId,
    location_id: config.locationId,
    name: config.name ?? existing?.name ?? null,
    contact: config.contact ?? existing?.contact ?? null,
    auto_reply_enabled: config.autoReplyEnabled ?? existing?.autoReplyEnabled ?? false,
    interval_minutes: config.intervalMinutes ?? existing?.intervalMinutes ?? 30,
    updated_at: now
  };
  await getPool().query(
    `INSERT INTO businesses (account_id, location_id, name, contact, auto_reply_enabled, interval_minutes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (account_id) DO UPDATE SET
       location_id = $2, name = $3, contact = $4, auto_reply_enabled = $5, interval_minutes = $6, updated_at = $7`,
    [row.account_id, row.location_id, row.name, row.contact, row.auto_reply_enabled, row.interval_minutes, row.updated_at]
  );
  return {
    accountId: row.account_id,
    locationId: row.location_id,
    name: row.name,
    contact: row.contact,
    autoReplyEnabled: row.auto_reply_enabled,
    intervalMinutes: row.interval_minutes,
    updatedAt: row.updated_at
  };
}

// --- Auto state (per accountId + locationId) ---

export async function getAutoState(accountId, locationId) {
  const res = await getPool().query(
    "SELECT replied_review_ids FROM auto_state WHERE account_id = $1 AND location_id = $2",
    [accountId, locationId]
  );
  const row = res.rows[0];
  if (!row) return { repliedReviewIds: [] };
  const ids = row.replied_review_ids;
  return { repliedReviewIds: Array.isArray(ids) ? ids : [] };
}

export async function setAutoState(accountId, locationId, state) {
  const ids = state?.repliedReviewIds ?? [];
  await getPool().query(
    `INSERT INTO auto_state (account_id, location_id, replied_review_ids)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id, location_id) DO UPDATE SET replied_review_ids = $3`,
    [accountId, locationId, JSON.stringify(ids)]
  );
}

export function useDb() {
  return Boolean(process.env.DATABASE_URL);
}
