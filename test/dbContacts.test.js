import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://user:pass@example.invalid/db";

const { __setPoolForTesting, replaceProContacts } = await import("../src/db.js");

function sqlStartsWith(sql, prefix) {
  return String(sql).trim().toUpperCase().startsWith(prefix);
}

test("replaceProContacts rolls back instead of leaving contacts deleted when an insert fails", async () => {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sqlStartsWith(sql, "SELECT")) return { rows: [] };
      if (sqlStartsWith(sql, "INSERT")) throw new Error("insert failed");
      return { rows: [] };
    },
    release() {
      released = true;
    }
  };
  __setPoolForTesting({ connect: async () => client });

  await assert.rejects(
    replaceProContacts("acct-1", [{ email: "new@example.com", first_name: "New" }]),
    /insert failed/
  );

  assert.deepEqual(
    queries.map((q) => String(q.sql).trim().split(/\s+/)[0].toUpperCase()),
    ["BEGIN", "SELECT", "DELETE", "INSERT", "ROLLBACK"]
  );
  assert.equal(released, true);
});

test("replaceProContacts commits delete-only replacements atomically", async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(sql) {
      statements.push(String(sql).trim().split(/\s+/)[0].toUpperCase());
      if (sqlStartsWith(sql, "SELECT")) return { rows: [{ email: "old@example.com" }] };
      return { rows: [] };
    },
    release() {
      released = true;
    }
  };
  __setPoolForTesting({ connect: async () => client });

  await replaceProContacts("acct-1", []);

  assert.deepEqual(statements, ["BEGIN", "SELECT", "DELETE", "COMMIT"]);
  assert.equal(released, true);
});
