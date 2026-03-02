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
  try {
    await client.query("ALTER TABLE businesses ADD COLUMN free_reply_used BOOLEAN NOT NULL DEFAULT false");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE businesses ADD COLUMN trial_ends_at TIMESTAMPTZ");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE businesses ADD COLUMN subscribed_at TIMESTAMPTZ");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE businesses ADD COLUMN stripe_customer_id TEXT");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE businesses ADD COLUMN is_pro BOOLEAN NOT NULL DEFAULT false");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  // Replyr Pro: contacts per business (all CSV rows; email optional for storage, required for sending)
  await client.query(`
    CREATE TABLE IF NOT EXISTS pro_contacts (
      id BIGSERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      email TEXT,
      first_name TEXT,
      birthday TEXT,
      phone TEXT,
      unsubscribed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pro_contacts_account ON pro_contacts(account_id);
  `);
  // Migrate old schema (account_id, email PK) to new (id PK, email nullable) if needed
  const hasId = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pro_contacts' AND column_name = 'id'"
  );
  if (hasId.rows.length === 0) {
    await client.query(`
      CREATE TABLE pro_contacts_new (id BIGSERIAL PRIMARY KEY, account_id TEXT NOT NULL, email TEXT, first_name TEXT, birthday TEXT, phone TEXT, unsubscribed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      INSERT INTO pro_contacts_new (account_id, email, first_name, birthday, phone, unsubscribed_at, created_at) SELECT account_id, email, first_name, birthday, phone, unsubscribed_at, created_at FROM pro_contacts;
      DROP TABLE pro_contacts;
      ALTER TABLE pro_contacts_new RENAME TO pro_contacts;
      CREATE INDEX IF NOT EXISTS idx_pro_contacts_account ON pro_contacts(account_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pro_contacts_account_email ON pro_contacts(account_id, email) WHERE email IS NOT NULL;
    `);
  } else {
    try {
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_pro_contacts_account_email ON pro_contacts(account_id, email) WHERE email IS NOT NULL");
    } catch (e) {
      if (e.code !== "42P07") throw e;
    }
  }
  // Pro campaigns: birthday settings (one per business)
  await client.query(`
    CREATE TABLE IF NOT EXISTS pro_birthday_settings (
      account_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT false,
      message_text TEXT,
      offer_text TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Pro event campaigns: opt-in per event per year (e.g. mothers_day_2026)
  await client.query(`
    CREATE TABLE IF NOT EXISTS pro_event_campaigns (
      account_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      event_year INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      message_text TEXT,
      offer_text TEXT,
      send_days_before INTEGER NOT NULL DEFAULT 14,
      confirmed_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, event_key, event_year)
    );
  `);
  try {
    await client.query("ALTER TABLE pro_event_campaigns ADD COLUMN send_days_before INTEGER NOT NULL DEFAULT 14");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  // Pro one-off campaigns (business picks date, subject, body)
  await client.query(`
    CREATE TABLE IF NOT EXISTS pro_one_off_campaigns (
      id SERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      send_date DATE NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pro_one_off_account_date ON pro_one_off_campaigns(account_id, send_date);
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
    "SELECT account_id, location_id, name, contact, auto_reply_enabled, interval_minutes, updated_at, free_reply_used, trial_ends_at, subscribed_at, stripe_customer_id, is_pro FROM businesses"
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
      updatedAt: row.updated_at,
      freeReplyUsed: row.free_reply_used ?? false,
      trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
      subscribedAt: row.subscribed_at ? new Date(row.subscribed_at).toISOString() : null,
      stripeCustomerId: row.stripe_customer_id ?? null,
      isPro: row.is_pro ?? false
    };
  }
  return out;
}

export async function getBusinessFromDb(accountId) {
  const res = await getPool().query(
    "SELECT account_id, location_id, name, contact, auto_reply_enabled, interval_minutes, updated_at, free_reply_used, trial_ends_at, subscribed_at, stripe_customer_id, is_pro FROM businesses WHERE account_id = $1",
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
    updatedAt: row.updated_at,
    freeReplyUsed: row.free_reply_used ?? false,
    trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
    subscribedAt: row.subscribed_at ? new Date(row.subscribed_at).toISOString() : null,
    stripeCustomerId: row.stripe_customer_id ?? null,
    isPro: row.is_pro ?? false
  };
}

export async function upsertBusinessInDb(config) {
  const now = new Date().toISOString();
  const existing = await getBusinessFromDb(config.accountId);
  const trialEndsAt = config.trialEndsAt !== undefined ? config.trialEndsAt : existing?.trialEndsAt ?? null;
  const subscribedAt = config.subscribedAt !== undefined ? config.subscribedAt : existing?.subscribedAt ?? null;
  const stripeCustomerId = config.stripeCustomerId !== undefined ? config.stripeCustomerId : existing?.stripeCustomerId ?? null;
  const isPro = config.isPro !== undefined ? config.isPro : existing?.isPro ?? false;
  const row = {
    account_id: config.accountId,
    location_id: config.locationId,
    name: config.name ?? existing?.name ?? null,
    contact: config.contact ?? existing?.contact ?? null,
    auto_reply_enabled: config.autoReplyEnabled ?? existing?.autoReplyEnabled ?? false,
    interval_minutes: config.intervalMinutes ?? existing?.intervalMinutes ?? 30,
    updated_at: now,
    free_reply_used: config.freeReplyUsed ?? existing?.freeReplyUsed ?? false,
    trial_ends_at: trialEndsAt,
    subscribed_at: subscribedAt,
    stripe_customer_id: stripeCustomerId,
    is_pro: isPro
  };
  await getPool().query(
    `INSERT INTO businesses (account_id, location_id, name, contact, auto_reply_enabled, interval_minutes, updated_at, free_reply_used, trial_ends_at, subscribed_at, stripe_customer_id, is_pro)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (account_id) DO UPDATE SET
       location_id = $2, name = $3, contact = $4, auto_reply_enabled = $5, interval_minutes = $6, updated_at = $7, free_reply_used = $8, trial_ends_at = $9, subscribed_at = $10, stripe_customer_id = $11, is_pro = $12`,
    [row.account_id, row.location_id, row.name, row.contact, row.auto_reply_enabled, row.interval_minutes, row.updated_at, row.free_reply_used, row.trial_ends_at, row.subscribed_at, row.stripe_customer_id, row.is_pro]
  );
  return {
    accountId: row.account_id,
    locationId: row.location_id,
    name: row.name,
    contact: row.contact,
    autoReplyEnabled: row.auto_reply_enabled,
    intervalMinutes: row.interval_minutes,
    updatedAt: row.updated_at,
    freeReplyUsed: row.free_reply_used,
    trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
    subscribedAt: row.subscribed_at ? new Date(row.subscribed_at).toISOString() : null,
    stripeCustomerId: row.stripe_customer_id ?? null,
    isPro: row.is_pro ?? false
  };
}

/** Return accountId for a business with this stripe_customer_id, or null */
export async function getAccountIdByStripeCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  const res = await getPool().query(
    "SELECT account_id FROM businesses WHERE stripe_customer_id = $1",
    [stripeCustomerId]
  );
  return res.rows[0]?.account_id ?? null;
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

// --- Pro contacts (Replyr Pro: CSV upload, per-account) ---

/** Get set of emails that have unsubscribed for this account (so we preserve opt-out on replace). */
export async function getProContactUnsubscribedEmails(accountId) {
  const res = await getPool().query(
    "SELECT email FROM pro_contacts WHERE account_id = $1 AND email IS NOT NULL AND unsubscribed_at IS NOT NULL",
    [accountId]
  );
  return new Set(res.rows.map((r) => (r.email || "").toLowerCase()));
}

export async function replaceProContacts(accountId, rows) {
  const client = getPool();
  const unsubscribedSet = await getProContactUnsubscribedEmails(accountId);
  await client.query("DELETE FROM pro_contacts WHERE account_id = $1", [accountId]);
  if (!rows.length) return;
  // Rows with email: dedupe by email (last wins). Rows without email: keep all.
  const withEmail = new Map();
  const withoutEmail = [];
  for (const r of rows) {
    const emailRaw = (r.email || "").trim();
    const email = emailRaw.toLowerCase() || null;
    const row = {
      email: emailRaw || null,
      first_name: (r.first_name || r.firstName || "").trim() || null,
      birthday: (r.birthday || r.birth_date || "").trim() || null,
      phone: (r.phone || "").trim() || null
    };
    if (email) withEmail.set(email, row);
    else withoutEmail.push(row);
  }
  const now = new Date().toISOString();
  for (const r of withEmail.values()) {
    const email = (r.email || "").trim().toLowerCase();
    const unsub = unsubscribedSet.has(email);
    await client.query(
      `INSERT INTO pro_contacts (account_id, email, first_name, birthday, phone, unsubscribed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, email, r.first_name, r.birthday, r.phone, unsub ? now : null, now]
    );
  }
  for (const r of withoutEmail) {
    await client.query(
      `INSERT INTO pro_contacts (account_id, email, first_name, birthday, phone, unsubscribed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, null, r.first_name, r.birthday, r.phone, null, now]
    );
  }
}

export async function getProContactsCount(accountId) {
  const res = await getPool().query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE email IS NOT NULL) AS with_email,
            COUNT(*) FILTER (WHERE email IS NOT NULL AND unsubscribed_at IS NOT NULL) AS unsubscribed
     FROM pro_contacts WHERE account_id = $1`,
    [accountId]
  );
  const row = res.rows[0];
  return {
    total: Number(row?.total ?? 0),
    withEmail: Number(row?.with_email ?? 0),
    unsubscribed: Number(row?.unsubscribed ?? 0)
  };
}

/** List contacts for an account (paginated). For campaigns, filter by email IS NOT NULL and unsubscribed_at IS NULL elsewhere. */
export async function getProContactsList(accountId, limit = 100, offset = 0) {
  const res = await getPool().query(
    `SELECT id, email, first_name, birthday, phone, unsubscribed_at IS NOT NULL AS unsubscribed
     FROM pro_contacts WHERE account_id = $1 ORDER BY id LIMIT $2 OFFSET $3`,
    [accountId, Math.min(Number(limit) || 100, 500), Number(offset) || 0]
  );
  return res.rows.map((r) => ({
    id: r.id,
    email: r.email ?? "",
    first_name: r.first_name ?? "",
    birthday: r.birthday ?? "",
    phone: r.phone ?? "",
    unsubscribed: !!r.unsubscribed
  }));
}

export async function setProContactUnsubscribed(accountId, email) {
  await getPool().query(
    "UPDATE pro_contacts SET unsubscribed_at = NOW() WHERE account_id = $1 AND LOWER(TRIM(email)) = LOWER(TRIM($2))",
    [accountId, email]
  );
}

// --- Pro birthday settings ---
export async function getProBirthdaySettings(accountId) {
  const res = await getPool().query(
    "SELECT enabled, message_text, offer_text, updated_at FROM pro_birthday_settings WHERE account_id = $1",
    [accountId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    enabled: row.enabled ?? false,
    messageText: row.message_text ?? "",
    offerText: row.offer_text ?? "",
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

export async function setProBirthdaySettings(accountId, settings) {
  const { enabled = false, messageText = "", offerText = "" } = settings;
  await getPool().query(
    `INSERT INTO pro_birthday_settings (account_id, enabled, message_text, offer_text, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (account_id) DO UPDATE SET enabled = $2, message_text = $3, offer_text = $4, updated_at = NOW()`,
    [accountId, !!enabled, messageText, offerText]
  );
  return getProBirthdaySettings(accountId);
}

// --- Pro event campaigns ---
export async function getProEventCampaign(accountId, eventKey, eventYear) {
  const res = await getPool().query(
    "SELECT status, message_text, offer_text, send_days_before, confirmed_at, sent_at FROM pro_event_campaigns WHERE account_id = $1 AND event_key = $2 AND event_year = $3",
    [accountId, eventKey, eventYear]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    status: row.status,
    messageText: row.message_text ?? "",
    offerText: row.offer_text ?? "",
    sendDaysBefore: row.send_days_before ?? 14,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null
  };
}

export async function upsertProEventCampaign(accountId, eventKey, eventYear, data) {
  const { status, messageText = "", offerText = "", sendDaysBefore, confirmedAt, sentAt } = data;
  const days = sendDaysBefore !== undefined ? Number(sendDaysBefore) : 14;
  await getPool().query(
    `INSERT INTO pro_event_campaigns (account_id, event_key, event_year, status, message_text, offer_text, send_days_before, confirmed_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (account_id, event_key, event_year) DO UPDATE SET status = $4, message_text = $5, offer_text = $6, send_days_before = $7, confirmed_at = $8, sent_at = $9`,
    [accountId, eventKey, eventYear, status || "pending", messageText, offerText, days, confirmedAt || null, sentAt || null]
  );
  return getProEventCampaign(accountId, eventKey, eventYear);
}

export async function getProEventCampaignsDueToSend() {
  const res = await getPool().query(
    `SELECT account_id, event_key, event_year, send_days_before FROM pro_event_campaigns
     WHERE status = 'confirmed' AND sent_at IS NULL`
  );
  return res.rows.map((r) => ({
    accountId: r.account_id,
    eventKey: r.event_key,
    eventYear: r.event_year,
    sendDaysBefore: r.send_days_before ?? 14
  }));
}

export async function markProEventCampaignSent(accountId, eventKey, eventYear) {
  await getPool().query(
    "UPDATE pro_event_campaigns SET sent_at = NOW(), status = 'sent' WHERE account_id = $1 AND event_key = $2 AND event_year = $3",
    [accountId, eventKey, eventYear]
  );
}

// --- Pro one-off campaigns ---
export async function createProOneOffCampaign(accountId, sendDate, subject, body) {
  const res = await getPool().query(
    `INSERT INTO pro_one_off_campaigns (account_id, send_date, subject, body, status)
     VALUES ($1, $2, $3, $4, 'scheduled') RETURNING id, account_id, send_date, subject, body, status, created_at`,
    [accountId, sendDate, subject, body]
  );
  const row = res.rows[0];
  return row ? { id: row.id, accountId: row.account_id, sendDate: row.send_date, subject: row.subject, body: row.body, status: row.status, createdAt: row.created_at } : null;
}

export async function getProOneOffCampaignsDueToSend() {
  const res = await getPool().query(
    `SELECT id, account_id, subject, body FROM pro_one_off_campaigns
     WHERE status = 'scheduled' AND send_date <= CURRENT_DATE`
  );
  return res.rows;
}

export async function markProOneOffCampaignSent(id) {
  await getPool().query("UPDATE pro_one_off_campaigns SET status = 'sent' WHERE id = $1", [id]);
}

// --- Pro contacts for sending (have email, not unsubscribed) ---
export async function getProContactsForSending(accountId) {
  const res = await getPool().query(
    "SELECT email, first_name, birthday FROM pro_contacts WHERE account_id = $1 AND email IS NOT NULL AND unsubscribed_at IS NULL",
    [accountId]
  );
  return res.rows.map((r) => ({
    email: r.email,
    firstName: r.first_name ?? "",
    birthday: r.birthday ?? ""
  }));
}
