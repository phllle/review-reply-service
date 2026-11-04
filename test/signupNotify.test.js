import { test } from "node:test";
import assert from "node:assert/strict";
import { signupNotifyRecipient, buildSignupEmail, notifyTrialSignup } from "../src/signupNotify.js";
import { isNewAccountSignup, businessKey } from "../src/businesses.js";

test("recipient: SIGNUP_NOTIFY_EMAIL, else ALERT_EMAIL, 'off' disables", () => {
  assert.equal(signupNotifyRecipient({ SIGNUP_NOTIFY_EMAIL: "a@x.com", ALERT_EMAIL: "b@x.com" }), "a@x.com");
  assert.equal(signupNotifyRecipient({ ALERT_EMAIL: "b@x.com" }), "b@x.com");
  assert.equal(signupNotifyRecipient({ SIGNUP_NOTIFY_EMAIL: "off", ALERT_EMAIL: "b@x.com" }), null);
  assert.equal(signupNotifyRecipient({}), null);
});

test("buildSignupEmail includes business, owner, trial end; strips newlines from subject", () => {
  const { subject, text } = buildSignupEmail(
    { name: "Castle\nNail Bar", accountId: "123", locationId: "loc1", placeId: "PX", trialEndsAt: "2026-12-04T00:00:00.000Z" },
    { ownerEmail: "owner@shop.com", now: new Date("2026-11-04T00:00:00.000Z") }
  );
  assert.equal(subject, "New Replyr trial: Castle Nail Bar");
  assert.match(text, /Owner:\s+owner@shop\.com/);
  assert.match(text, /Account ID: 123/);
  assert.match(text, /place_id:PX/);
  assert.match(text, /Trial ends: 2026-12-04/);
});

test("notifyTrialSignup sends via injected sender and sets reply-to", async () => {
  const sent = [];
  const r = await notifyTrialSignup(
    { name: "Biz", accountId: "1" },
    { ownerEmail: "o@x.com", env: { ALERT_EMAIL: "me@x.com" }, send: async (m) => sent.push(m) }
  );
  assert.deepEqual(r, { sent: true });
  assert.deepEqual(sent[0].to, ["me@x.com"]);
  assert.equal(sent[0].reply_to, "o@x.com");
});

test("notifyTrialSignup is a no-op without recipient or key, and never throws", async () => {
  assert.equal((await notifyTrialSignup({ accountId: "1" }, { env: {} })).reason, "no-recipient");
  assert.equal((await notifyTrialSignup({ accountId: "1" }, { env: { ALERT_EMAIL: "me@x.com" } })).reason, "no-resend-key");
  const r = await notifyTrialSignup({ accountId: "1" }, {
    env: { ALERT_EMAIL: "me@x.com" }, logger: { warn() {} }, send: async () => { throw new Error("boom"); }
  });
  assert.deepEqual(r, { sent: false, reason: "error" });
});

test("isNewAccountSignup: only the first row for an account counts as a signup", () => {
  const map = { [businessKey("acct1", "locA")]: { accountId: "acct1", locationId: "locA" } };
  assert.equal(isNewAccountSignup({}, { accountId: "acct1", locationId: "locA" }), true);
  assert.equal(isNewAccountSignup(map, { accountId: "acct1", locationId: "locB" }), false); // 2nd location
  assert.equal(isNewAccountSignup(map, { accountId: "acct1", locationId: "locA" }), false); // update
  assert.equal(isNewAccountSignup(map, { accountId: "acct2", locationId: "locZ" }), true);
});
