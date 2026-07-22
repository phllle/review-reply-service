import { test } from "node:test";
import assert from "node:assert/strict";

// Make sure no alert env is set so neither Resend nor Twilio is called.
delete process.env.ALERT_EMAIL;
delete process.env.ALERT_PHONE;
delete process.env.RESEND_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const { sendFailureAlert, _resetAlertThrottle } = await import("../src/alert.js");

test("sendFailureAlert resolves with no env configured (no-op)", async () => {
  _resetAlertThrottle();
  await assert.doesNotReject(
    sendFailureAlert({
      businessName: "Test",
      accountId: "acct-1",
      error: new Error("boom")
    })
  );
});

test("sendFailureAlert: handles result-only payload", async () => {
  _resetAlertThrottle();
  await assert.doesNotReject(
    sendFailureAlert({
      businessName: "Test",
      accountId: "acct-1",
      result: { attempted: 3, succeeded: 1, failed: 2, details: [{ status: "error", message: "x" }] }
    })
  );
});

test("sendFailureAlert: handles empty opts", async () => {
  _resetAlertThrottle();
  await assert.doesNotReject(sendFailureAlert());
});

test("_resetAlertThrottle is exported and callable", () => {
  assert.equal(typeof _resetAlertThrottle, "function");
  _resetAlertThrottle();
});

test("throttle: identical alert is suppressed within cooldown", async () => {
  _resetAlertThrottle();
  const err = new Error("Google API error 503: service unavailable");
  const first = await sendFailureAlert({ businessName: "Castle Nail Bar", accountId: "acct-1", error: err });
  const second = await sendFailureAlert({ businessName: "Castle Nail Bar", accountId: "acct-1", error: err });
  assert.equal(first.throttled, false, "first alert should send");
  assert.equal(second.throttled, true, "duplicate alert should be suppressed");
});

test("throttle: request-id/digits in error still de-dupe to one alert", async () => {
  _resetAlertThrottle();
  const a = await sendFailureAlert({ accountId: "acct-1", error: new Error("Google API error 503: req_011AbC") });
  const b = await sendFailureAlert({ accountId: "acct-1", error: new Error("Google API error 503: req_099XyZ") });
  assert.equal(a.throttled, false);
  assert.equal(b.throttled, true, "differing request ids should collapse to one signature");
});

test("throttle: different account is not suppressed", async () => {
  _resetAlertThrottle();
  const a = await sendFailureAlert({ accountId: "acct-1", error: new Error("boom") });
  const b = await sendFailureAlert({ accountId: "acct-2", error: new Error("boom") });
  assert.equal(a.throttled, false);
  assert.equal(b.throttled, false, "distinct accounts alert independently");
});

test("throttle: different error type is not suppressed", async () => {
  _resetAlertThrottle();
  const a = await sendFailureAlert({ accountId: "acct-1", error: new Error("Google API error 503") });
  const b = await sendFailureAlert({ accountId: "acct-1", error: new Error("Anthropic 404 model not found") });
  assert.equal(a.throttled, false);
  assert.equal(b.throttled, false, "a genuinely different error should still alert");
});
