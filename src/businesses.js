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

function hasOwn(config, key) {
  return Object.prototype.hasOwnProperty.call(config, key);
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

/** Get all businesses (accountId -> config) */
export async function getAllBusinesses() {
  return await readBusinesses();
}

/** Get one business by accountId */
export async function getBusiness(accountId) {
  const all = await readBusinesses();
  return all[accountId] || null;
}

/** Create or update a business. Config: { accountId, locationId, name?, contact?, autoReplyEnabled?, intervalMinutes?, autoReplyMode? } */
export async function upsertBusiness(config) {
  if (db.useDb()) {
    const all = await readBusinesses();
    const existing = all[config.accountId] || {};
    const isNew = !existing.accountId;
    const merged = {
      accountId: config.accountId,
      locationId: config.locationId,
      name: config.name ?? existing.name ?? null,
      contact: config.contact ?? existing.contact ?? DEFAULT_CONTACT,
      autoReplyEnabled: config.autoReplyEnabled ?? existing.autoReplyEnabled ?? false,
      intervalMinutes: config.intervalMinutes ?? existing.intervalMinutes ?? 30,
      freeReplyUsed: config.freeReplyUsed ?? existing.freeReplyUsed ?? false,
      trialEndsAt: hasOwn(config, "trialEndsAt") ? config.trialEndsAt : existing.trialEndsAt ?? (isNew ? getTrialEndsAtForNewBusiness() : null),
      subscribedAt: hasOwn(config, "subscribedAt") ? config.subscribedAt : existing.subscribedAt ?? null,
      stripeCustomerId: hasOwn(config, "stripeCustomerId") ? config.stripeCustomerId : existing.stripeCustomerId ?? null,
      isPro: config.isPro ?? existing.isPro ?? false,
      proTier: config.proTier ?? existing.proTier ?? "starter",
      autoReplyMode: config.autoReplyMode ?? existing.autoReplyMode ?? "instant",
      notificationEmail: hasOwn(config, "notificationEmail") ? config.notificationEmail : existing.notificationEmail ?? null
    };
    return await db.upsertBusinessInDb(merged);
  }
  const all = await readBusinesses();
  const existing = all[config.accountId] || {};
  const isNew = !existing.accountId;
  all[config.accountId] = {
    accountId: config.accountId,
    locationId: config.locationId,
    name: config.name ?? existing.name ?? null,
    contact: config.contact ?? existing.contact ?? DEFAULT_CONTACT,
    autoReplyEnabled: config.autoReplyEnabled ?? existing.autoReplyEnabled ?? false,
    intervalMinutes: config.intervalMinutes ?? existing.intervalMinutes ?? 30,
    freeReplyUsed: config.freeReplyUsed ?? existing.freeReplyUsed ?? false,
    trialEndsAt: hasOwn(config, "trialEndsAt") ? config.trialEndsAt : existing.trialEndsAt ?? (isNew ? getTrialEndsAtForNewBusiness() : null),
    subscribedAt: hasOwn(config, "subscribedAt") ? config.subscribedAt : existing.subscribedAt ?? null,
    stripeCustomerId: hasOwn(config, "stripeCustomerId") ? config.stripeCustomerId : existing.stripeCustomerId ?? null,
    isPro: config.isPro ?? existing.isPro ?? false,
    proTier: config.proTier ?? existing.proTier ?? "starter",
    autoReplyMode: config.autoReplyMode ?? existing.autoReplyMode ?? "instant",
    notificationEmail: hasOwn(config, "notificationEmail") ? config.notificationEmail : existing.notificationEmail ?? null,
    updatedAt: new Date().toISOString()
  };
  await writeBusinesses(all);
  return all[config.accountId];
}

/**
 * Set notification_email only when it's currently empty. Used to auto-fill from
 * Google OAuth without overwriting a value the owner manually typed in.
 *
 * @returns {Promise<boolean>} true if the value was set; false otherwise
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
  const existing = all[accountId];
  if (!existing) return false;
  if (existing.notificationEmail) return false;
  all[accountId] = { ...existing, notificationEmail: trimmed, updatedAt: new Date().toISOString() };
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

/** True if trial is still active (no end date or end date in the future) */
function isTrialActive(b) {
  if (!b.trialEndsAt) return true;
  return new Date(b.trialEndsAt) > new Date();
}

/** True if business has an active subscription */
function isSubscribed(b) {
  return !!(b.subscribedAt);
}

/** Get all businesses that have auto-reply enabled and are allowed to run (trial active, base subscription, Pro, or gratis list) */
export async function getEnabledBusinesses() {
  const all = await readBusinesses();
  return Object.values(all).filter(
    (b) =>
      b.autoReplyEnabled === true &&
      b.accountId &&
      b.locationId &&
      (isTrialActive(b) || isSubscribed(b) || isGratisAccount(b.accountId) || b.isPro)
  );
}

export { DEFAULT_CONTACT };
