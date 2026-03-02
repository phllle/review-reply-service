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

/** Replace all contacts for an account. Rows: [{ email, first_name?, birthday?, phone? }]. Preserves unsubscribed_at. Stores all rows (with or without email). */
export async function replaceProContacts(accountId, rows) {
  if (db.useDb()) {
    return await db.replaceProContacts(accountId, rows);
  }
  const all = await readAll();
  const existing = all[accountId] || [];
  const unsubscribedSet = new Set(
    existing.filter((c) => c.unsubscribed_at && c.email).map((c) => (c.email || "").toLowerCase())
  );
  const withEmail = new Map();
  const withoutEmail = [];
  for (const r of rows) {
    const email = (r.email || "").trim();
    const emailLower = email.toLowerCase() || null;
    const row = {
      email: email || "",
      first_name: (r.first_name ?? r.firstName ?? "").trim() || "",
      birthday: (r.birthday ?? r.birth_date ?? "").trim() || "",
      phone: (r.phone ?? "").trim() || "",
      unsubscribed_at: emailLower && unsubscribedSet.has(emailLower) ? new Date().toISOString() : null
    };
    if (emailLower) withEmail.set(emailLower, row);
    else withoutEmail.push(row);
  }
  all[accountId] = [...withEmail.values(), ...withoutEmail];
  await writeAll(all);
}

/** Get contact count (total, withEmail, unsubscribed) for an account. */
export async function getProContactsCount(accountId) {
  if (db.useDb()) {
    return await db.getProContactsCount(accountId);
  }
  const list = (await readAll())[accountId] || [];
  const withEmail = list.filter((c) => (c.email || "").trim()).length;
  const unsubscribed = list.filter((c) => c.unsubscribed_at && (c.email || "").trim()).length;
  return { total: list.length, withEmail, unsubscribed };
}

/** List contacts for an account (paginated). File-based: no id, use index. */
export async function getProContactsList(accountId, limit = 100, offset = 0) {
  if (db.useDb()) {
    return await db.getProContactsList(accountId, limit, offset);
  }
  const list = (await readAll())[accountId] || [];
  const lim = Math.min(Number(limit) || 100, 500);
  const off = Number(offset) || 0;
  const slice = list.slice(off, off + lim);
  return slice.map((c, i) => ({
    id: off + i + 1,
    email: c.email ?? "",
    first_name: c.first_name ?? "",
    birthday: c.birthday ?? "",
    phone: c.phone ?? "",
    unsubscribed: !!c.unsubscribed_at
  }));
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
