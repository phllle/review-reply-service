import { test } from "node:test";
import assert from "node:assert/strict";

// Ensure the SUT sees no DSN before importing.
delete process.env.SENTRY_DSN;
const sentry = await import("../src/sentry.js");

test("isEnabled is false when SENTRY_DSN is unset", () => {
  assert.equal(sentry.isEnabled(), false);
});

test("init returns null when disabled", async () => {
  const result = await sentry.init();
  assert.equal(result, null);
});

test("captureException is a no-op when disabled (does not throw)", () => {
  assert.doesNotThrow(() => sentry.captureException(new Error("boom"), { kind: "test" }));
});

test("requestHandler middleware passes through when disabled", () => {
  const mw = sentry.requestHandler();
  let called = false;
  mw({ path: "/x" }, {}, () => {
    called = true;
  });
  assert.equal(called, true);
});

test("errorHandler forwards the error to next() when disabled", () => {
  const mw = sentry.errorHandler();
  const err = new Error("boom");
  let received;
  mw(err, {}, {}, (e) => {
    received = e;
  });
  assert.equal(received, err);
});

test("flush is a no-op when disabled", async () => {
  await assert.doesNotReject(sentry.flush(50));
});
