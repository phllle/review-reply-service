/**
 * Replyr Pro — "Ask for reviews".
 *
 * Lets an owner log walk-in customers (with consent), mark who came in today,
 * and send a one-tap Google-review request SMS to today's visitors. Reuses the
 * Pro SMS quota + sender. DB-only (needs pro_contacts).
 */

import * as db from "./db.js";
import { getBusiness } from "./businesses.js";
import { canAccessAccount, readSessionAccountId } from "./sessionAuth.js";
import { getCurrentMonthKey, getIncludedSmsForTier, normalizeProTier } from "./proPlan.js";
import { sendProCampaignSms } from "./campaignSms.js";

const REQUEST_COOLDOWN_DAYS = 90;

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(
        "ALTER TABLE pro_contacts ADD COLUMN IF NOT EXISTS visited_on DATE, ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS source TEXT"
      );
      await db.query("ALTER TABLE businesses ADD COLUMN IF NOT EXISTS place_id TEXT");
    })().catch((err) => {
      // Reset so a transient failure can retry on the next request.
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/** Today's date (YYYY-MM-DD) in America/Los_Angeles. */
function todayLA(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

function phoneDigits(v) {
  return String(v || "").replace(/\D+/g, "");
}

/** Accept YYYY-MM-DD or MM/DD; return a normalized string or null. */
function normalizeBirthday(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) {
    const mm = String(md[1]).padStart(2, "0");
    const dd = String(md[2]).padStart(2, "0");
    return `${mm}/${dd}`;
  }
  return null;
}

function reviewUrl(business) {
  const placeId = (business?.placeId || process.env.GOOGLE_PLACE_ID || "").trim();
  if (placeId) {
    return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
  }
  const q = encodeURIComponent(business?.name || "our business");
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function buildMessage(firstName, businessName, url) {
  const first = (firstName || "there").trim() || "there";
  return `Hi ${first}, it's ${businessName}. Thanks for coming in. If we earned it, a quick Google review helps: ${url}`;
}

/** Resolve account + enforce Pro + session access. Returns { business } or sends an error and returns null. */
async function requireProAccount(req, res) {
  const accountId =
    (req.query.accountId && String(req.query.accountId).trim()) ||
    (req.body && req.body.accountId && String(req.body.accountId).trim()) ||
    readSessionAccountId(req);
  if (!accountId) {
    res.status(401).json({ error: "Sign in required" });
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  if (!db.useDb()) {
    res.status(503).json({ error: "Database required for review requests." });
    return null;
  }
  const business = await getBusiness(accountId);
  if (!business) {
    res.status(404).json({ error: "Business not found." });
    return null;
  }
  if (!business.isPro) {
    res.status(403).json({ error: "Replyr Pro required." });
    return null;
  }
  return { accountId, business };
}

async function smsUsage(business) {
  const included = getIncludedSmsForTier(normalizeProTier(business.proTier));
  const used = await db.getProSmsUsage(business.accountId, getCurrentMonthKey());
  return { used, included, remaining: Math.max(0, included - used) };
}

export function registerReviewRequests(app) {
  app.get("/pro/review-requests", async (req, res, next) => {
    try {
      const ctx = await requireProAccount(req, res);
      if (!ctx) return;
      await ensureSchema();
      const { accountId, business } = ctx;
      const today = todayLA();

      const todayRows = await db.query(
        `SELECT id, first_name, phone, email, visited_on, review_requested_at
           FROM pro_contacts
          WHERE account_id = $1 AND visited_on = $2
          ORDER BY first_name ASC NULLS LAST`,
        [accountId, today]
      );
      const allRows = await db.query(
        `SELECT id, first_name, phone, email, birthday, visited_on, review_requested_at, unsubscribed_at
           FROM pro_contacts
          WHERE account_id = $1
          ORDER BY first_name ASC NULLS LAST
          LIMIT 1000`,
        [accountId]
      );
      const mapRow = (r) => ({
        id: r.id,
        firstName: r.first_name || "",
        phone: (r.phone || "").trim() || null,
        email: (r.email || "").trim() || null,
        birthday: r.birthday || null,
        visitedToday: r.visited_on ? String(r.visited_on).slice(0, 10) === today : false,
        requestedAt: r.review_requested_at ? new Date(r.review_requested_at).toISOString() : null,
        unsubscribed: r.unsubscribed_at != null
      });

      const preview = buildMessage("there", business.name || "your business", reviewUrl(business));
      res.json({
        today: todayRows.rows.map(mapRow),
        contacts: allRows.rows.map(mapRow),
        preview,
        sms: await smsUsage(business)
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/pro/review-requests/contacts", async (req, res, next) => {
    try {
      const ctx = await requireProAccount(req, res);
      if (!ctx) return;
      await ensureSchema();
      const { accountId } = ctx;
      const body = req.body || {};
      const firstName = String(body.firstName || "").trim();
      const phone = String(body.phone || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const birthday = normalizeBirthday(body.birthday);
      const permission = body.permission === true;
      const markToday = body.markToday === true;

      if (!permission) {
        return res.status(400).json({ error: "Consent is required before adding a contact." });
      }
      if (!phone && !email) {
        return res.status(400).json({ error: "Add a phone or email." });
      }
      const digits = phoneDigits(phone);
      const today = todayLA();

      // Merge on phone digits or lowercased email; else insert.
      const existing = await db.query(
        `SELECT id FROM pro_contacts
          WHERE account_id = $1
            AND ( ($2 <> '' AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $2)
               OR ($3 <> '' AND LOWER(COALESCE(email,'')) = $3) )
          LIMIT 1`,
        [accountId, digits, email]
      );

      let id;
      if (existing.rows[0]) {
        id = existing.rows[0].id;
        await db.query(
          `UPDATE pro_contacts SET
             first_name = COALESCE(NULLIF($2, ''), first_name),
             phone = COALESCE(NULLIF($3, ''), phone),
             email = COALESCE(NULLIF($4, ''), email),
             birthday = COALESCE($5, birthday),
             visited_on = CASE WHEN $6 THEN $7::date ELSE visited_on END
           WHERE id = $1 AND account_id = $8`,
          [id, firstName, phone, email, birthday, markToday, today, accountId]
        );
      } else {
        const inserted = await db.query(
          `INSERT INTO pro_contacts (account_id, email, first_name, birthday, phone, source, visited_on, created_at)
           VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4, NULLIF($5,''), 'manual', $6, NOW())
           RETURNING id`,
          [accountId, email, firstName, birthday, phone, markToday ? today : null]
        );
        id = inserted.rows[0].id;
      }
      res.json({ ok: true, id, markedToday: markToday });
    } catch (err) {
      next(err);
    }
  });

  app.post("/pro/review-requests/visit", async (req, res, next) => {
    try {
      const ctx = await requireProAccount(req, res);
      if (!ctx) return;
      await ensureSchema();
      const { accountId } = ctx;
      const contactId = req.body?.contactId;
      const on = req.body?.on === true;
      if (contactId == null) return res.status(400).json({ error: "contactId required" });
      const today = todayLA();
      const r = await db.query(
        `UPDATE pro_contacts SET visited_on = $2 WHERE id = $1 AND account_id = $3 RETURNING id`,
        [contactId, on ? today : null, accountId]
      );
      if (!r.rows[0]) return res.status(404).json({ error: "Contact not found" });
      res.json({ ok: true, visitedToday: on });
    } catch (err) {
      next(err);
    }
  });

  app.post("/pro/review-requests/send", async (req, res, next) => {
    try {
      const ctx = await requireProAccount(req, res);
      if (!ctx) return;
      await ensureSchema();
      const { accountId, business } = ctx;
      const excludeIds = Array.isArray(req.body?.excludeIds)
        ? req.body.excludeIds.map((x) => String(x))
        : [];
      const today = todayLA();
      const businessName = business.name || "your business";
      const url = reviewUrl(business);

      const rows = (
        await db.query(
          `SELECT id, first_name, phone
             FROM pro_contacts
            WHERE account_id = $1
              AND visited_on = $2
              AND unsubscribed_at IS NULL
              AND phone IS NOT NULL AND TRIM(phone) <> ''
              AND (review_requested_at IS NULL OR review_requested_at < NOW() - INTERVAL '${REQUEST_COOLDOWN_DAYS} days')`,
          [accountId, today]
        )
      ).rows.filter((r) => !excludeIds.includes(String(r.id)));

      let sent = 0;
      let failed = 0;
      for (const c of rows) {
        try {
          const msg = buildMessage(c.first_name, businessName, url);
          const ok = await sendProCampaignSms(accountId, c.phone, msg, req.log || console);
          if (ok) {
            sent += 1;
            await db.query(
              "UPDATE pro_contacts SET review_requested_at = NOW(), visited_on = NULL WHERE id = $1 AND account_id = $2",
              [c.id, accountId]
            );
          } else {
            failed += 1;
          }
        } catch (err) {
          failed += 1;
          req.log?.error?.({ err, accountId, id: c.id }, "Review request SMS failed");
        }
      }
      res.json({ ok: true, sent, failed, sms: await smsUsage(business) });
    } catch (err) {
      next(err);
    }
  });
}
