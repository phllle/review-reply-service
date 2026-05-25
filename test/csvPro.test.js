import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProCsv, validateFile } from "../src/csvPro.js";

function buf(s) {
  return Buffer.from(s, "utf8");
}

test("parseProCsv: happy path with standard headers", () => {
  const csv = "email,first_name,birthday,phone\njane@x.com,Jane,1990-05-15,555-555-1212\n";
  const out = parseProCsv(buf(csv));
  assert.equal(out.error, undefined);
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rows[0], {
    email: "jane@x.com",
    first_name: "Jane",
    birthday: "1990-05-15",
    phone: "555-555-1212"
  });
});

test("parseProCsv: alias headers (Email Address, First, DOB, Mobile)", () => {
  const csv = "Email Address,First,DOB,Mobile\njohn@x.com,John,1985-01-01,5551234567\n";
  const out = parseProCsv(buf(csv));
  assert.equal(out.error, undefined);
  assert.equal(out.rows[0].email, "john@x.com");
  assert.equal(out.rows[0].first_name, "John");
  assert.equal(out.rows[0].birthday, "1985-01-01");
  assert.equal(out.rows[0].phone, "5551234567");
});

test("parseProCsv: missing email column produces an error", () => {
  const csv = "name,phone\nJane,555-1212\n";
  const out = parseProCsv(buf(csv));
  assert.match(out.error || "", /email/i);
});

test("parseProCsv: explicit mapping overrides alias detection", () => {
  const csv = "user_email,fname\nzoe@x.com,Zoe\n";
  const out = parseProCsv(buf(csv), {
    mapping: { email: "user_email", first_name: "fname" }
  });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.rows[0], {
    email: "zoe@x.com",
    first_name: "Zoe",
    birthday: undefined,
    phone: undefined
  });
});

test("parseProCsv: file too large (>5MB) returns error before parsing", () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 0x61);
  const out = parseProCsv(big);
  assert.match(out.error || "", /too large/i);
});

test("parseProCsv: empty CSV returns error", () => {
  const out = parseProCsv(buf(""));
  assert.match(out.error || "", /no data/i);
});

test("parseProCsv: keeps rows with blank email (caller decides what to do)", () => {
  const csv = "email,first_name\n,Jane\nbob@x.com,Bob\n";
  const out = parseProCsv(buf(csv));
  assert.equal(out.error, undefined);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].email, "");
  assert.equal(out.rows[1].email, "bob@x.com");
});

test("validateFile: accepts .csv with common mimetypes", () => {
  assert.equal(validateFile("text/csv", "list.csv"), null);
  assert.equal(validateFile("application/csv", "list.csv"), null);
  assert.equal(validateFile("text/plain", "list.csv"), null);
  assert.equal(validateFile("application/octet-stream", "list.csv"), null);
});

test("validateFile: rejects non-csv extension and unknown mimetype", () => {
  const err = validateFile("application/zip", "list.zip");
  assert.match(err || "", /\.csv/);
});

test("validateFile: when no mimetype provided, accepts based on extension", () => {
  assert.equal(validateFile("", "list.csv"), null);
  assert.equal(validateFile(undefined, "list.CSV"), null);
});
