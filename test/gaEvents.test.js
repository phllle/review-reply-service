import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isGaEventsConfigured,
  buildEventPayload,
  sendGaEvent,
  fireTrialStart,
  fireSubscriptionPaid,
  sha256Hex
} from "../src/gaEvents.js";

const ENV = { GA_MEASUREMENT_ID: "G-TEST1234", GA_API_SECRET: "secret-xyz" };
const BUSINESS = { accountId: "98765", gaClientId: "111.222", gclid: "gclid-1" };

function captureFetch(calls, ok = true) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok, status: ok ? 204 : 500 };
  };
}

test("isGaEventsConfigured: needs a valid ID and a secret", () => {
  assert.equal(isGaEventsConfigured(ENV), true);
  assert.equal(isGaEventsConfigured({}), false);
  assert.equal(isGaEventsConfigured({ GA_MEASUREMENT_ID: "G-TEST1234" }), false);
  assert.equal(isGaEventsConfigured({ GA_API_SECRET: "x" }), false);
  assert.equal(isGaEventsConfigured({ GA_MEASUREMENT_ID: "UA-123", GA_API_SECRET: "x" }), false);
});

test("buildEventPayload: client_id, event_id param, user_id", () => {
  const payload = buildEventPayload({
    clientId: "111.222",
    userId: "98765",
    name: "trial_start",
    params: { value: 19, currency: "USD" },
    eventId: "98765"
  });
  assert.equal(payload.client_id, "111.222");
  assert.equal(payload.user_id, "98765");
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].name, "trial_start");
  assert.equal(payload.events[0].params.event_id, "98765");
  assert.equal(payload.events[0].params.value, 19);
});

test("buildEventPayload: email is hashed into user_data, never raw", () => {
  const payload = buildEventPayload({
    clientId: "c",
    name: "trial_start",
    userEmail: "  Owner@Example.com "
  });
  assert.deepEqual(payload.user_data, { sha256_email_address: [sha256Hex("owner@example.com")] });
  assert.ok(!JSON.stringify(payload).includes("Owner@Example.com"));
});

test("sendGaEvent: skips silently when GA env vars are unset", async () => {
  let called = false;
  const res = await sendGaEvent({
    business: BUSINESS,
    name: "trial_start",
    env: {},
    fetchImpl: async () => {
      called = true;
      return { ok: true };
    },
    logger: null
  });
  assert.deepEqual(res, { sent: false, reason: "not-configured" });
  assert.equal(called, false);
});

test("sendGaEvent: posts to the Measurement Protocol endpoint with stored gclid", async () => {
  const calls = [];
  const res = await sendGaEvent({
    business: BUSINESS,
    name: "trial_start",
    env: ENV,
    fetchImpl: captureFetch(calls),
    logger: null
  });
  assert.deepEqual(res, { sent: true });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://www.google-analytics.com/mp/collect?"));
  assert.ok(calls[0].url.includes("measurement_id=G-TEST1234"));
  assert.ok(calls[0].url.includes("api_secret=secret-xyz"));
  assert.equal(calls[0].body.client_id, "111.222");
  assert.equal(calls[0].body.events[0].params.gclid, "gclid-1");
});

test("sendGaEvent: falls back to a synthetic client ID from the account ID", async () => {
  const calls = [];
  await sendGaEvent({
    business: { accountId: "42" },
    name: "first_reply_posted",
    env: ENV,
    fetchImpl: captureFetch(calls),
    logger: null
  });
  assert.equal(calls[0].body.client_id, "replyr-42");
});

test("sendGaEvent: network failure is swallowed, reported as not sent", async () => {
  const res = await sendGaEvent({
    business: BUSINESS,
    name: "trial_start",
    env: ENV,
    fetchImpl: async () => {
      throw new Error("boom");
    },
    logger: null
  });
  assert.deepEqual(res, { sent: false, reason: "error" });
});

test("fireTrialStart: value 19 USD, event_id = accountId", async () => {
  const calls = [];
  await fireTrialStart(BUSINESS, { env: ENV, fetchImpl: captureFetch(calls), logger: null });
  const evt = calls[0].body.events[0];
  assert.equal(evt.name, "trial_start");
  assert.equal(evt.params.value, 19);
  assert.equal(evt.params.currency, "USD");
  assert.equal(evt.params.event_id, "98765");
});

test("fireSubscriptionPaid: cents become dollars", async () => {
  const calls = [];
  await fireSubscriptionPaid(BUSINESS, {
    amountCents: 1900,
    env: ENV,
    fetchImpl: captureFetch(calls),
    logger: null
  });
  const evt = calls[0].body.events[0];
  assert.equal(evt.name, "subscription_paid");
  assert.equal(evt.params.value, 19);
  assert.equal(evt.params.currency, "USD");
});
