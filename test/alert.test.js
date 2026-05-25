import { test } from "node:test";
import assert from "node:assert/strict";

// Make sure no alert env is set so neither Resend nor Twilio is called.
delete process.env.ALERT_EMAIL;
delete process.env.ALERT_PHONE;
delete process.env.RESEND_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const { sendFailureAlert } = await import("../src/alert.js");

test("sendFailureAlert resolves with no env configured (no-op)", async () => {
  await assert.doesNotReject(
    sendFailureAlert({
      businessName: "Test",
      accountId: "acct-1",
      error: new Error("boom")
    })
  );
});

test("sendFailureAlert: handles result-only payload", async () => {
  await assert.doesNotReject(
    sendFailureAlert({
      businessName: "Test",
      accountId: "acct-1",
      result: { attempted: 3, succeeded: 1, failed: 2, details: [{ status: "error", message: "x" }] }
    })
  );
});

test("sendFailureAlert: handles empty opts", async () => {
  await assert.doesNotReject(sendFailureAlert());
});
