import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUSINESSES_PATH = path.resolve(__dirname, "..", "businesses.json");

const DEFAULT_CONTACT = "us using the contact details on our Google Business listing";

function getTrialEndsAtForNewBusiness() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString();
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

/** Create or update a business. Config: { accountId, locationId, name?, contact?, autoReplyEnabled?, intervalMinutes? } */
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
      trialEndsAt: config.trialEndsAt ?? existing.trialEndsAt ?? (isNew ? getTrialEndsAtForNewBusiness() : null),
      subscribedAt: config.subscribedAt ?? existing.subscribedAt ?? null,
      stripeCustomerId: config.stripeCustomerId ?? existing.stripeCustomerId ?? null
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
    trialEndsAt: config.trialEndsAt ?? existing.trialEndsAt ?? (isNew ? getTrialEndsAtForNewBusiness() : null),
    subscribedAt: config.subscribedAt ?? existing.subscribedAt ?? null,
    stripeCustomerId: config.stripeCustomerId ?? existing.stripeCustomerId ?? null,
    updatedAt: new Date().toISOString()
  };
  await writeBusinesses(all);
  return all[config.accountId];
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

/** Get all businesses that have auto-reply enabled and are allowed to run (trial active or subscribed) */
export async function getEnabledBusinesses() {
  const all = await readBusinesses();
  return Object.values(all).filter(
    (b) =>
      b.autoReplyEnabled === true &&
      b.accountId &&
      b.locationId &&
      (isTrialActive(b) || isSubscribed(b))
  );
}

export { DEFAULT_CONTACT };
