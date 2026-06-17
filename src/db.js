import pg from "pg";

const { Pool } = pg;

let pool = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pool options for Railway / hosted Postgres (SSL, timeouts). */
function poolOptionsFromUrl(url) {
  const opts = {
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 15_000)
  };
  const forceSsl =
    String(process.env.DATABASE_SSL || "").toLowerCase() === "true" ||
    String(process.env.PGSSLMODE || "").toLowerCase() === "require";
  let sslmode = "";
  try {
    const normalized = url.replace(/^postgres:/i, "postgresql:");
    sslmode = (new URL(normalized).searchParams.get("sslmode") || "").toLowerCase();
  } catch {
    /* ignore malformed URL; pg may still connect */
  }
  const needsSsl =
    forceSsl ||
    sslmode === "require" ||
    sslmode === "verify-ca" ||
    sslmode === "verify-full" ||
    (process.env.NODE_ENV === "production" && /railway\.app|rlwy\.net/i.test(url));
  if (needsSsl && sslmode !== "disable") {
    opts.ssl = { rejectUnauthorized: sslmode === "verify-full" };
  }
  return opts;
}

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new Pool(poolOptionsFromUrl(url));
    pool.on("error", (err) => {
      console.error("PostgreSQL pool idle client error:", err.message || err);
    });
  }
  return pool;
}

/** Create tables if they don't exist. Call once at startup when using DB. */
async function initSchema() {
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
  try {
    await client.query("ALTER TABLE businesses ADD COLUMN pro_tier TEXT NOT NULL DEFAULT 'starter'");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE businesses ADD COLUMN auto_reply_mode TEXT NOT NULL DEFAULT 'instant'");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE businesses ADD COLUMN notification_email TEXT");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  // Auto-reply preview mode: when business has auto_reply_mode='delayed', low-star
  // replies are queued here until send_after passes (or cancelled_at is set).
  await client.query(`
    CREATE TABLE IF NOT EXISTS pending_replies (
      id BIGSERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      rating INTEGER,
      reviewer_name TEXT,
      review_comment TEXT,
      generated_reply TEXT NOT NULL,
      send_after TIMESTAMPTZ NOT NULL,
      processing_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      send_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_replies_review
      ON pending_replies(account_id, location_id, review_id);
    CREATE INDEX IF NOT EXISTS idx_pending_replies_due
      ON pending_replies(send_after)
      WHERE cancelled_at IS NULL AND sent_at IS NULL;
  `);
  try {
    await client.query("ALTER TABLE pending_replies ADD COLUMN processing_at TIMESTAMPTZ");
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
  try {
    await client.query("ALTER TABLE pro_event_campaigns ADD COLUMN send_email BOOLEAN NOT NULL DEFAULT true");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE pro_event_campaigns ADD COLUMN send_sms BOOLEAN NOT NULL DEFAULT true");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE pro_event_campaigns ADD COLUMN send_at_local TEXT");
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
  try {
    await client.query("ALTER TABLE pro_birthday_settings ADD COLUMN send_email BOOLEAN NOT NULL DEFAULT true");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE pro_birthday_settings ADD COLUMN send_sms BOOLEAN NOT NULL DEFAULT true");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE pro_one_off_campaigns ADD COLUMN send_email BOOLEAN NOT NULL DEFAULT true");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  try {
    await client.query("ALTER TABLE pro_one_off_campaigns ADD COLUMN send_sms BOOLEAN NOT NULL DEFAULT true");
  } catch (err) {
    if (err.code !== "42701") throw err;
  }
  await client.query(`
    CREATE TABLE IF NOT EXISTS pro_sms_usage (
      account_id TEXT NOT NULL,
      month_key TEXT NOT NULL,
      sms_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, month_key)
    );
  `);
}

/** Create tables if they don't exist. Retries transient connection errors (Railway Postgres wake-up). */
export async function init() {
  const attempts = Math.max(1, Number(process.env.DB_INIT_RETRIES || 5));
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await initSchema();
      return;
    } catch (err) {
      lastErr = err;
      const retryable =
        err.code === "ECONNRESET" ||
        err.code === "ECONNREFUSED" ||
        err.code === "ETIMEDOUT" ||
        err.code === "57P03" ||
        err.code === "53300";
      if (!retryable || i === attempts) break;
      const delayMs = Math.min(15_000, 2000 * i);
      console.warn(
        `Database init attempt ${i}/${attempts} failed (${err.code || err.message}); retrying in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }
  const hint =
    "Check Railway: Postgres plugin running, DATABASE_URL on the web service (reference variable), and use the private URL if both services are in the same project.";
  const wrapped = new Error(`${lastErr?.message || lastErr}. ${hint}`);
  wrapped.cause = lastErr;
  throw wrapped;
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

export async function writeToken(accountId, tokenData) {
  if (!accountId || !tokenData || !(tokenData.refresh_token || tokenData.access_token)) {
    return;
  }
  await getPool().query(
    "INSERT INTO tokens (account_id, data) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET data = $2",
    [accountId, JSON.stringify(tokenData)]
  );
}

export async function writeTokens(data) {
  for (const [accountId, tokenData] of Object.entries(data || {})) {
    await writeToken(accountId, tokenData);
  }
}

// --- Businesses ---

const BUSINESS_COLUMNS =
  "account_id, location_id, name, contact, auto_reply_enabled, interval_minutes, updated_at, free_reply_used, trial_ends_at, subscribed_at, stripe_customer_id, is_pro, pro_tier, auto_reply_mode, notification_email";

function rowToBusiness(row) {
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
    isPro: row.is_pro ?? false,
    proTier: row.pro_tier || "starter",
    autoReplyMode: row.auto_reply_mode || "instant",
    notificationEmail: row.notification_email || null
  };
}

export async function getAllBusinessesFromDb() {
  const res = await getPool().query(`SELECT ${BUSINESS_COLUMNS} FROM businesses`);
  const out = {};
  for (const row of res.rows) {
    out[row.account_id] = rowToBusiness(row);
  }
  return out;
}

export async function getBusinessFromDb(accountId) {
  const res = await getPool().query(
    `SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE account_id = $1`,
    [accountId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return rowToBusiness(row);
}

export async function upsertBusinessInDb(config) {
  const now = new Date().toISOString();
  const existing = await getBusinessFromDb(config.accountId);
  const trialEndsAt = config.trialEndsAt !== undefined ? config.trialEndsAt : existing?.trialEndsAt ?? null;
  const subscribedAt = config.subscribedAt !== undefined ? config.subscribedAt : existing?.subscribedAt ?? null;
  const stripeCustomerId = config.stripeCustomerId !== undefined ? config.stripeCustomerId : existing?.stripeCustomerId ?? null;
  const isPro = config.isPro !== undefined ? config.isPro : existing?.isPro ?? false;
  const proTier = config.proTier !== undefined ? config.proTier : existing?.proTier ?? "starter";
  const autoReplyMode = config.autoReplyMode !== undefined ? config.autoReplyMode : existing?.autoReplyMode ?? "instant";
  const notificationEmail = config.notificationEmail !== undefined ? config.notificationEmail : existing?.notificationEmail ?? null;
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
    is_pro: isPro,
    pro_tier: proTier || "starter",
    auto_reply_mode: autoReplyMode || "instant",
    notification_email: notificationEmail
  };
  await getPool().query(
    `INSERT INTO businesses (account_id, location_id, name, contact, auto_reply_enabled, interval_minutes, updated_at, free_reply_used, trial_ends_at, subscribed_at, stripe_customer_id, is_pro, pro_tier, auto_reply_mode, notification_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (account_id) DO UPDATE SET
       location_id = $2, name = $3, contact = $4, auto_reply_enabled = $5, interval_minutes = $6, updated_at = $7, free_reply_used = $8, trial_ends_at = $9, subscribed_at = $10, stripe_customer_id = $11, is_pro = $12, pro_tier = $13, auto_reply_mode = $14, notification_email = $15`,
    [row.account_id, row.location_id, row.name, row.contact, row.auto_reply_enabled, row.interval_minutes, row.updated_at, row.free_reply_used, row.trial_ends_at, row.subscribed_at, row.stripe_customer_id, row.is_pro, row.pro_tier, row.auto_reply_mode, row.notification_email]
  );
  return rowToBusiness(row);
}

/**
 * Conditional-write: only sets notification_email when it's currently NULL or
 * empty. Returns true if a row was updated, false otherwise.
 */
export async function setBusinessNotificationEmailIfEmpty(accountId, email) {
  if (!accountId || !email) return false;
  const res = await getPool().query(
    `UPDATE businesses
       SET notification_email = $2, updated_at = NOW()
     WHERE account_id = $1 AND (notification_email IS NULL OR notification_email = '')`,
    [accountId, email]
  );
  return (res.rowCount || 0) > 0;
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

/** Mark all contacts with this phone number as unsubscribed (SMS STOP reply). Phone can be E.164 or any format. */
export async function setProContactUnsubscribedByPhone(phone) {
  if (!phone || typeof phone !== "string") return;
  const digits = phone.replace(/\D/g, "");
  const ten = digits.length === 10 ? digits : digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : null;
  if (!ten) return;
  const eleven = "1" + ten;
  await getPool().query(
    `UPDATE pro_contacts SET unsubscribed_at = NOW()
     WHERE REGEXP_REPLACE(TRIM(COALESCE(phone, '')), '\\D', '', 'g') IN ($1, $2)`,
    [ten, eleven]
  );
}

// --- Pro birthday settings ---
export async function getProBirthdaySettings(accountId) {
  const res = await getPool().query(
    "SELECT enabled, message_text, offer_text, send_email, send_sms, updated_at FROM pro_birthday_settings WHERE account_id = $1",
    [accountId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    enabled: row.enabled ?? false,
    messageText: row.message_text ?? "",
    offerText: row.offer_text ?? "",
    sendEmail: row.send_email !== false,
    sendSms: row.send_sms !== false,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

export async function setProBirthdaySettings(accountId, settings) {
  const { enabled = false, messageText = "", offerText = "", sendEmail, sendSms } = settings;
  const sendEmailVal = sendEmail !== undefined ? !!sendEmail : true;
  const sendSmsVal = sendSms !== undefined ? !!sendSms : true;
  await getPool().query(
    `INSERT INTO pro_birthday_settings (account_id, enabled, message_text, offer_text, send_email, send_sms, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (account_id) DO UPDATE SET enabled = $2, message_text = $3, offer_text = $4, send_email = $5, send_sms = $6, updated_at = NOW()`,
    [accountId, !!enabled, messageText, offerText, sendEmailVal, sendSmsVal]
  );
  return getProBirthdaySettings(accountId);
}

// --- Pro event campaigns ---
export async function getProEventCampaign(accountId, eventKey, eventYear) {
  const res = await getPool().query(
    "SELECT status, message_text, offer_text, send_days_before, send_at_local, send_email, send_sms, confirmed_at, sent_at FROM pro_event_campaigns WHERE account_id = $1 AND event_key = $2 AND event_year = $3",
    [accountId, eventKey, eventYear]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    status: row.status,
    messageText: row.message_text ?? "",
    offerText: row.offer_text ?? "",
    sendDaysBefore: row.send_days_before ?? 14,
    sendAtLocal: row.send_at_local ?? null,
    sendEmail: row.send_email !== false,
    sendSms: row.send_sms !== false,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null
  };
}

export async function upsertProEventCampaign(accountId, eventKey, eventYear, data) {
  const { status, messageText = "", offerText = "", sendDaysBefore, sendAtLocal, sendEmail, sendSms, confirmedAt, sentAt } = data;
  const days = sendDaysBefore !== undefined ? Number(sendDaysBefore) : 14;
  const sendEmailVal = sendEmail !== undefined ? !!sendEmail : true;
  const sendSmsVal = sendSms !== undefined ? !!sendSms : true;
  await getPool().query(
    `INSERT INTO pro_event_campaigns (account_id, event_key, event_year, status, message_text, offer_text, send_days_before, send_at_local, send_email, send_sms, confirmed_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (account_id, event_key, event_year) DO UPDATE SET status = $4, message_text = $5, offer_text = $6, send_days_before = $7, send_at_local = $8, send_email = $9, send_sms = $10, confirmed_at = $11, sent_at = $12`,
    [accountId, eventKey, eventYear, status || "pending", messageText, offerText, days, sendAtLocal || null, sendEmailVal, sendSmsVal, confirmedAt || null, sentAt || null]
  );
  return getProEventCampaign(accountId, eventKey, eventYear);
}

export async function getProEventCampaignsDueToSend() {
  const res = await getPool().query(
    `SELECT account_id, event_key, event_year, send_days_before, send_at_local, send_email, send_sms FROM pro_event_campaigns
     WHERE status = 'confirmed' AND sent_at IS NULL`
  );
  return res.rows.map((r) => ({
    accountId: r.account_id,
    eventKey: r.event_key,
    eventYear: r.event_year,
    sendDaysBefore: r.send_days_before ?? 14,
    sendAtLocal: r.send_at_local ?? null,
    sendEmail: r.send_email !== false,
    sendSms: r.send_sms !== false
  }));
}

export async function markProEventCampaignSent(accountId, eventKey, eventYear) {
  await getPool().query(
    "UPDATE pro_event_campaigns SET sent_at = NOW(), status = 'sent' WHERE account_id = $1 AND event_key = $2 AND event_year = $3",
    [accountId, eventKey, eventYear]
  );
}

// --- Pro one-off campaigns ---
export async function createProOneOffCampaign(accountId, sendDate, subject, body, sendEmail = true, sendSms = true) {
  const res = await getPool().query(
    `INSERT INTO pro_one_off_campaigns (account_id, send_date, subject, body, send_email, send_sms, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'scheduled') RETURNING id, account_id, send_date, subject, body, send_email, send_sms, status, created_at`,
    [accountId, sendDate, subject, body, !!sendEmail, !!sendSms]
  );
  const row = res.rows[0];
  return row ? { id: row.id, accountId: row.account_id, sendDate: row.send_date, subject: row.subject, body: row.body, sendEmail: row.send_email !== false, sendSms: row.send_sms !== false, status: row.status, createdAt: row.created_at } : null;
}

export async function getProOneOffCampaignsDueToSend() {
  const res = await getPool().query(
    `SELECT id, account_id, subject, body, send_email, send_sms FROM pro_one_off_campaigns
     WHERE status = 'scheduled' AND send_date <= CURRENT_DATE`
  );
  return res.rows.map((r) => ({
    id: r.id,
    account_id: r.account_id,
    subject: r.subject,
    body: r.body,
    send_email: r.send_email !== false,
    send_sms: r.send_sms !== false
  }));
}

export async function markProOneOffCampaignSent(id) {
  await getPool().query("UPDATE pro_one_off_campaigns SET status = 'sent' WHERE id = $1", [id]);
}

// --- Pro contacts for sending (have email and/or phone, not unsubscribed) ---
export async function getProContactsForSending(accountId) {
  const res = await getPool().query(
    `SELECT email, first_name, birthday, phone FROM pro_contacts
     WHERE account_id = $1 AND unsubscribed_at IS NULL
       AND ((email IS NOT NULL AND TRIM(email) != '') OR (phone IS NOT NULL AND TRIM(phone) != ''))`,
    [accountId]
  );
  return res.rows.map((r) => ({
    email: r.email ? String(r.email).trim() || null : null,
    firstName: r.first_name ?? "",
    birthday: r.birthday ?? "",
    phone: (r.phone || "").trim() || null
  }));
}

// --- Pro SMS usage metering (per account, per month) ---
export async function getProSmsUsage(accountId, monthKey) {
  const res = await getPool().query(
    "SELECT sms_count FROM pro_sms_usage WHERE account_id = $1 AND month_key = $2",
    [accountId, monthKey]
  );
  return Number(res.rows[0]?.sms_count || 0);
}

export async function incrementProSmsUsage(accountId, monthKey, amount = 1) {
  const inc = Math.max(0, Number(amount) || 0);
  if (!inc) return getProSmsUsage(accountId, monthKey);
  const res = await getPool().query(
    `INSERT INTO pro_sms_usage (account_id, month_key, sms_count, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (account_id, month_key) DO UPDATE
     SET sms_count = pro_sms_usage.sms_count + $3, updated_at = NOW()
     RETURNING sms_count`,
    [accountId, monthKey, inc]
  );
  return Number(res.rows[0]?.sms_count || 0);
}

/**
 * Atomically add one SMS segment only if current count is strictly below maxSegments.
 * @returns {number|null} new count after increment, or null if cap already reached
 */
export async function incrementProSmsUsageIfUnderCap(accountId, monthKey, maxSegments) {
  const cap = Math.max(0, Number(maxSegments) || 0);
  const res = await getPool().query(
    `INSERT INTO pro_sms_usage (account_id, month_key, sms_count, updated_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (account_id, month_key)
     DO UPDATE SET
       sms_count = pro_sms_usage.sms_count + 1,
       updated_at = NOW()
     WHERE pro_sms_usage.sms_count < $3
     RETURNING sms_count`,
    [accountId, monthKey, cap]
  );
  if (!res.rows.length) return null;
  return Number(res.rows[0].sms_count);
}

/** Decrement by 1 (floor at 0). Used when Twilio send fails after a reserved segment. */
export async function decrementProSmsUsage(accountId, monthKey, amount = 1) {
  const dec = Math.max(0, Number(amount) || 0);
  if (!dec) return getProSmsUsage(accountId, monthKey);
  await getPool().query(
    `UPDATE pro_sms_usage SET sms_count = GREATEST(0, sms_count - $3), updated_at = NOW()
     WHERE account_id = $1 AND month_key = $2`,
    [accountId, monthKey, dec]
  );
  return getProSmsUsage(accountId, monthKey);
}

// --- Pending replies (auto-reply preview/delay mode) ---

const PENDING_REPLY_COLUMNS =
  "id, account_id, location_id, review_id, rating, reviewer_name, review_comment, generated_reply, send_after, processing_at, cancelled_at, sent_at, send_error, created_at";

function rowToPendingReply(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    locationId: row.location_id,
    reviewId: row.review_id,
    rating: row.rating,
    reviewerName: row.reviewer_name,
    reviewComment: row.review_comment,
    generatedReply: row.generated_reply,
    sendAfter: row.send_after ? new Date(row.send_after).toISOString() : null,
    processingAt: row.processing_at ? new Date(row.processing_at).toISOString() : null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    sendError: row.send_error,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
  };
}

const PENDING_REPLY_PROCESSING_STALE_SQL = "NOW() - INTERVAL '15 minutes'";

/**
 * Insert a pending reply. Returns null if a pending row already exists for
 * (account, location, review) — caller should treat that as "already queued".
 */
export async function insertPendingReply({
  accountId,
  locationId,
  reviewId,
  rating,
  reviewerName,
  reviewComment,
  generatedReply,
  sendAfter
}) {
  const res = await getPool().query(
    `INSERT INTO pending_replies
       (account_id, location_id, review_id, rating, reviewer_name, review_comment, generated_reply, send_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id, location_id, review_id) DO NOTHING
     RETURNING ${PENDING_REPLY_COLUMNS}`,
    [accountId, locationId, reviewId, rating, reviewerName, reviewComment, generatedReply, sendAfter]
  );
  return rowToPendingReply(res.rows[0]);
}

/** True if there is an open (non-cancelled, non-sent) pending row for this review. */
export async function hasOpenPendingReply(accountId, locationId, reviewId) {
  const res = await getPool().query(
    `SELECT 1 FROM pending_replies
     WHERE account_id = $1 AND location_id = $2 AND review_id = $3
       AND cancelled_at IS NULL AND sent_at IS NULL`,
    [accountId, locationId, reviewId]
  );
  return res.rows.length > 0;
}

export async function getPendingRepliesDueToSend(now = new Date()) {
  const res = await getPool().query(
    `SELECT ${PENDING_REPLY_COLUMNS} FROM pending_replies
     WHERE cancelled_at IS NULL AND sent_at IS NULL AND send_after <= $1
       AND (processing_at IS NULL OR processing_at < ${PENDING_REPLY_PROCESSING_STALE_SQL})
     ORDER BY send_after ASC
     LIMIT 200`,
    [now]
  );
  return res.rows.map(rowToPendingReply);
}

/**
 * Atomically claim an open pending reply before making the external Google call.
 * Returns null if it was cancelled, sent, or claimed by another worker first.
 */
export async function claimPendingReplyForSend(id) {
  const res = await getPool().query(
    `UPDATE pending_replies
       SET processing_at = NOW(), send_error = NULL
     WHERE id = $1
       AND cancelled_at IS NULL
       AND sent_at IS NULL
       AND (processing_at IS NULL OR processing_at < ${PENDING_REPLY_PROCESSING_STALE_SQL})
     RETURNING ${PENDING_REPLY_COLUMNS}`,
    [id]
  );
  return rowToPendingReply(res.rows[0]);
}

/** Mark a pending reply cancelled. Returns the updated row, or null if not found / already terminal. */
export async function cancelPendingReply(accountId, locationId, reviewId) {
  const res = await getPool().query(
    `UPDATE pending_replies
       SET cancelled_at = NOW()
     WHERE account_id = $1 AND location_id = $2 AND review_id = $3
       AND cancelled_at IS NULL AND sent_at IS NULL
       AND (processing_at IS NULL OR processing_at < ${PENDING_REPLY_PROCESSING_STALE_SQL})
     RETURNING ${PENDING_REPLY_COLUMNS}`,
    [accountId, locationId, reviewId]
  );
  return rowToPendingReply(res.rows[0]);
}

export async function markPendingReplySent(id) {
  await getPool().query(
    "UPDATE pending_replies SET sent_at = NOW(), processing_at = NULL, send_error = NULL WHERE id = $1 AND cancelled_at IS NULL",
    [id]
  );
}

export async function markPendingReplyError(id, errorMessage) {
  await getPool().query(
    "UPDATE pending_replies SET processing_at = NULL, send_error = $2 WHERE id = $1 AND sent_at IS NULL AND cancelled_at IS NULL",
    [id, String(errorMessage || "").slice(0, 1000)]
  );
}

// --- Admin metrics aggregates ---

/** Number of pending_replies rows that are still queued (not cancelled, not sent). */
export async function getOpenPendingRepliesCount() {
  const res = await getPool().query(
    "SELECT COUNT(*)::int AS n FROM pending_replies WHERE cancelled_at IS NULL AND sent_at IS NULL"
  );
  return Number(res.rows[0]?.n || 0);
}

/** Sum of sms_count across all businesses for the given month_key. */
export async function getProSmsUsageSum(monthKey) {
  const res = await getPool().query(
    "SELECT COALESCE(SUM(sms_count), 0)::int AS total FROM pro_sms_usage WHERE month_key = $1",
    [monthKey]
  );
  return Number(res.rows[0]?.total || 0);
}
