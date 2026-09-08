import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUSINESSES_PATH = path.resolve(__dirname, "..", "businesses.json");

const DEFAULT_CONTACT = "us using the contact details on our Google Business listing";

/** Comma/space-separated Google account IDs that get base Replyr without trial/subscription (set REPLYR_GRATIS_ACCOUNT_IDS). */
export function isGratisAccount(accountId) {
  if (!accountId) return false;
  const raw = (process.env.REPLYR_GRATIS_ACCOUNT_IDS || "").trim();
  if (!raw) return false;
  const ids = new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
  return ids.has(String(accountId).trim());
}

function getTrialEndsAtForNewBusiness() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString();
}

/** Map key for a business row. One Google account may have many locations. */
export function businessKey(accountId, locationId) {
  return `${accountId}::${locationId}`;
}

/**
 * Pure merge for an upsert. Per-location fields (name, contact, auto-reply,
 * notification, digest, place_id) come from the existing row at this exact
 * (accountId, locationId). Account-level billing fields (trial, subscription,
 * Stripe customer, Pro tier) are inherited from an existing sibling location
 * when this row is brand new — billing is per Google account, so a second
 * location starts out matching the account's billing without waiting for the
 * Stripe webhook. Does no IO; safe to unit-test.
 */
export function mergeBusinessUpsert(map, config, { now = new Date().toISOString() } = {}) {
  const key = businessKey(config.accountId, config.locationId);
  const existing = map[key] || {};
  const isNewRow = !existing.accountId;
  let billing = existing;
  if (isNewRow) {
    const sibling = Object.values(map).find(
      (b) => b && b.accountId === config.accountId && b.locationId !== config.locationId
    );
    if (sibling) billing = sibling;
  }
  // A genuinely new account (new row with no sibling to inherit from) starts a trial.
  const isNewAccount = isNewRow && billing === existing;
  return {
    accountId: config.accountId,
    locationId: config.locationId,
    name: config.name ?? existing.name ?? null,
    contact: config.contact ?? existing.contact ?? DEFAULT_CONTACT,
    autoReplyEnabled: config.autoReplyEnabled ?? existing.autoReplyEnabled ?? false,
    intervalMinutes: config.intervalMinutes ?? existing.intervalMinutes ?? 30,
    freeRepliesUsed: config.freeRepliesUsed ?? existing.freeRepliesUsed ?? (existing.freeReplyUsed ? 5 : 0),
    trialEndsAt: config.trialEndsAt ?? billing.trialEndsAt ?? (isNewAccount ? getTrialEndsAtForNewBusiness() : null),
    subscribedAt: config.subscribedAt ?? billing.subscribedAt ?? null,
    stripeCustomerId: config.stripeCustomerId ?? billing.stripeCustomerId ?? null,
    isPro: config.isPro ?? billing.isPro ?? false,
    proTier: config.proTier ?? billing.proTier ?? "starter",
    autoReplyMode: config.autoReplyMode ?? existing.autoReplyMode ?? "instant",
    notificationEmail: config.notificationEmail ?? existing.notificationEmail ?? null,
    weeklyDigestEnabled: config.weeklyDigestEnabled ?? existing.weeklyDigestEnabled ?? true,
    lastWeeklyDigestAt: config.lastWeeklyDigestAt ?? existing.lastWeeklyDigestAt ?? null,
    lastDigestRatingAvg: config.lastDigestRatingAvg ?? existing.lastDigestRatingAvg ?? null,
    placeId: config.placeId ?? existing.placeId ?? null,
    updatedAt: now
  };
}

/** True if trial is still active (no end date or end date in the future) */
export function isTrialActive(b, now = new Date()) {
  if (!b.trialEndsAt) return true;
  return new Date(b.trialEndsAt) > now;
}

/** True if business has an active subscription */
export function isSubscribed(b) {
  return !!(b.subscribedAt);
}

/**
 * Pure: filter a business map (or array) to rows eligible to auto-reply. isGratis
 * is injected so this stays free of env/IO for testing. Each location is judged
 * on its own auto_reply_enabled flag, so multiple locations under one account are
 * independent.
 */
export function selectEnabledBusinesses(mapOrList, { isGratis = isGratisAccount, now = new Date() } = {}) {
  const list = Array.isArray(mapOrList) ? mapOrList : Object.values(mapOrList || {});
  return list.filter(
    (b) =>
      b &&
      b.autoReplyEnabled === true &&
      b.accountId &&
      b.locationId &&
      (isTrialActive(b, now) || isSubscribed(b) || isGratis(b.accountId) || b.isPro)
  );
}

async function readBusinesses() {
  if (db.useDb()) {
    return await db.getAllBusinessesFromDb();
  }
  try {
    const data = await fs.readFile(BUSINESSES_PATH, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeBusinesses(obj) {
  if (db.useDb()) {
    for (const config of Object.values(obj)) {
      await db.upsertBusinessInDb(config);
    }
    return;
  }
  await fs.writeFile(BUSINESSES_PATH, JSON.stringify(obj, null, 2), "utf8");
}

/** Get all businesses ("accountId::locationId" -> config), one entry per location. */
export async function getAllBusinesses() {
  return await readBusinesses();
}

/**
 * Get one business. With a locationId, returns that exact location. Without one,
 * returns the account's primary (first) location — the default for account-level
 * callers and single-location accounts. Billing fields mirror across an account's
 * locations, so account-level reads can safely use the primary.
 */
export async function getBusiness(accountId, locationId = null) {
  const all = await readBusinesses();
  if (locationId != null) return all[businessKey(accountId, locationId)] || null;
  const rows = Object.values(all).filter((b) => b && b.accountId === accountId);
  if (!rows.length) return null;
  rows.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return rows[0];
}

/** All location rows for one Google account, primary (lowest id) first. */
export async function getBusinessesForAccount(accountId) {
  const all = await readBusinesses();
  return Object.values(all)
    .filter((b) => b && b.accountId === accountId)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

/**
 * Create or update a business location. Keyed by (accountId, locationId) so a
 * second location INSERTs a new row instead of clobbering the first.
 * Config: { accountId, locationId, name?, contact?, autoReplyEnabled?, intervalMinutes?, autoReplyMode? }
 */
export async function upsertBusiness(config) {
  const all = await readBusinesses();
  const merged = mergeBusinessUpsert(all, config);
  if (db.useDb()) {
    return await db.upsertBusinessInDb(merged);
  }
  all[businessKey(config.accountId, config.locationId)] = merged;
  await writeBusinesses(all);
  return merged;
}

/**
 * Set notification_email only when it's currently empty. Used to auto-fill from
 * Google OAuth without overwriting a value the owner manually typed in. Applies
 * to every location row of the account whose email is still empty.
 *
 * @returns {Promise<boolean>} true if a value was set; false otherwise
 */
export async function setNotificationEmailIfEmpty(accountId, email) {
  if (!accountId || !email) return false;
  const trimmed = String(email).trim().toLowerCase();
  if (!trimmed) return false;
  if (db.useDb()) {
    const wrote = await db.setBusinessNotificationEmailIfEmpty(accountId, trimmed);
    return wrote;
  }
  const all = await readBusinesses();
  let changed = false;
  for (const [k, b] of Object.entries(all)) {
    if (b && b.accountId === accountId && !b.notificationEmail) {
      all[k] = { ...b, notificationEmail: trimmed, updatedAt: new Date().toISOString() };
      changed = true;
    }
  }
  if (!changed) return false;
  await writeBusinesses(all);
  return true;
}

/** Get accountId for a business with this stripeCustomerId (for webhook). */
export async function getAccountIdByStripeCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  if (db.useDb()) return await db.getAccountIdByStripeCustomerId(stripeCustomerId);
  const all = await readBusinesses();
  const found = Object.values(all).find((b) => b.stripeCustomerId === stripeCustomerId);
  return found?.accountId ?? null;
}

/** Get all businesses that have auto-reply enabled and are allowed to run (trial active, base subscription, Pro, or gratis list) */
export async function getEnabledBusinesses() {
  return selectEnabledBusinesses(await readBusinesses());
}

export { DEFAULT_CONTACT };
