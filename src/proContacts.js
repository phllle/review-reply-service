/**
 * Replyr Pro: customer contacts per business (CSV upload).
 * Uses DB when DATABASE_URL is set; otherwise pro-contacts.json.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRO_CONTACTS_PATH = path.resolve(__dirname, "..", "pro-contacts.json");

async function readAll() {
  if (db.useDb()) return null;
  try {
    const data = await fs.readFile(PRO_CONTACTS_PATH, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeAll(obj) {
  if (db.useDb()) return;
  await fs.writeFile(PRO_CONTACTS_PATH, JSON.stringify(obj, null, 2), "utf8");
}

/** Replace all contacts for an account. Rows: [{ email, first_name?, birthday?, phone? }]. Preserves unsubscribed_at for emails that were already unsubscribed. */
export async function replaceProContacts(accountId, rows) {
  if (db.useDb()) {
    return await db.replaceProContacts(accountId, rows);
  }
  const all = await readAll();
  const existing = all[accountId] || [];
  const unsubscribedSet = new Set(
    existing.filter((c) => c.unsubscribed_at).map((c) => (c.email || "").toLowerCase())
  );
  const normalized = rows.map((r) => {
    const email = (r.email || "").trim().toLowerCase();
    return {
      email,
      first_name: (r.first_name ?? r.firstName ?? "").trim() || null,
      birthday: (r.birthday ?? r.birth_date ?? "").trim() || null,
      phone: (r.phone ?? "").trim() || null,
      unsubscribed_at: email && unsubscribedSet.has(email) ? new Date().toISOString() : null
    };
  });
  const byEmail = new Map();
  for (const row of normalized) {
    if (row.email) byEmail.set(row.email, row);
  }
  all[accountId] = Array.from(byEmail.values());
  await writeAll(all);
}

/** Get contact count and unsubscribed count for an account. */
export async function getProContactsCount(accountId) {
  if (db.useDb()) {
    return await db.getProContactsCount(accountId);
  }
  const all = await readAll();
  const list = all[accountId] || [];
  const unsubscribed = list.filter((c) => c.unsubscribed_at).length;
  return { total: list.length, unsubscribed };
}

/** Mark a contact as unsubscribed (opt-out). */
export async function setProContactUnsubscribed(accountId, email) {
  if (db.useDb()) {
    return await db.setProContactUnsubscribed(accountId, email);
  }
  const all = await readAll();
  const list = all[accountId] || [];
  const key = (email || "").trim().toLowerCase();
  for (const c of list) {
    if ((c.email || "").toLowerCase() === key) {
      c.unsubscribed_at = new Date().toISOString();
      break;
    }
  }
  all[accountId] = list;
  await writeAll(all);
}
