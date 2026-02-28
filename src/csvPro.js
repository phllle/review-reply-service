/**
 * Parse CSV for Pro contacts: map headers to email, first_name, birthday, phone.
 * Required: email. Optional: first_name, birthday, phone.
 * Headers are matched case-insensitively; spaces become underscores.
 */

import { parse } from "csv-parse/sync";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME = ["text/csv", "text/plain", "application/csv"];
const EXT = ".csv";

/** Normalize header for mapping: lowercase, trim, spaces -> underscore */
function norm(s) {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

const EMAIL_ALIASES = ["email", "e_mail", "email_address"];
const FIRST_NAME_ALIASES = ["first_name", "firstname", "name", "first"];
const BIRTHDAY_ALIASES = ["birthday", "birth_date", "dob", "date_of_birth", "birth"];
const PHONE_ALIASES = ["phone", "phone_number", "mobile", "tel", "telephone"];

function findColumn(headers, aliases) {
  const normalized = headers.map((h, i) => ({ key: norm(h), i }));
  for (const a of aliases) {
    const found = normalized.find((n) => n.key === a || n.key.replace(/_/g, "") === a.replace(/_/g, ""));
    if (found) return found.i;
  }
  return -1;
}

/**
 * Parse CSV buffer and return { headers, rows, error? }.
 * rows are { email, first_name?, birthday?, phone? }. Rows without valid email are skipped.
 */
export function parseProCsv(buffer, options = {}) {
  const { mapping = null } = options;
  if (buffer.length > MAX_FILE_BYTES) {
    return { error: "File too large (max 5MB)" };
  }
  let raw;
  try {
    raw = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true
    });
  } catch (e) {
    return { error: "Invalid CSV: " + (e.message || String(e)) };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { headers: [], rows: [], error: "CSV has no data rows" };
  }
  const headers = Object.keys(raw[0] || {});
  const emailCol =
    mapping?.email != null
      ? headers.indexOf(mapping.email)
      : findColumn(headers, EMAIL_ALIASES);
  if (emailCol === -1 && (mapping?.email == null || !headers.includes(mapping.email))) {
    return {
      headers,
      rows: [],
      error: "CSV must have an email column. Use a column named 'email', 'Email', or map your column below."
    };
  }
  const emailKey = mapping?.email != null ? mapping.email : headers[emailCol];
  const firstKey =
    mapping?.first_name != null
      ? mapping.first_name
      : headers[findColumn(headers, FIRST_NAME_ALIASES)];
  const birthKey =
    mapping?.birthday != null
      ? mapping.birthday
      : headers[findColumn(headers, BIRTHDAY_ALIASES)];
  const phoneKey =
    mapping?.phone != null ? mapping.phone : headers[findColumn(headers, PHONE_ALIASES)];

  const rows = [];
  for (const row of raw) {
    const email = (row[emailKey] || "").trim();
    if (!email) continue;
    rows.push({
      email,
      first_name: firstKey ? (row[firstKey] || "").trim() || undefined : undefined,
      birthday: birthKey ? (row[birthKey] || "").trim() || undefined : undefined,
      phone: phoneKey ? (row[phoneKey] || "").trim() || undefined : undefined
    });
  }
  return { headers, rows };
}

export function validateFile(mimetype, originalname) {
  const name = (originalname || "").toLowerCase();
  const okExt = name.endsWith(EXT);
  const okMime = !mimetype || ALLOWED_MIME.includes(mimetype) || mimetype === "application/octet-stream";
  if (!okExt && !okMime) return "Only .csv files are allowed (max 5MB)";
  return null;
}
