import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_FAILED_SUBJECT,
  formatAmountDue,
  buildPaymentFailedEmail,
  sendPaymentFailedEmail,
  shouldSendPaymentFailed,
  dunningStampPatch,
  dunningClearPatch,
  handlePaymentFailed
} from "../src/lifecycleEmails.js";

const business = {
  accountId: "acct-1",
  locationId: "loc-1",
  notificationEmail: "owner@example.com",
  dunningSentAt: null
};

test("formatAmountDue: cents → dollars; junk → null", () => {
  assert.equal(formatAmountDue(1900), "$19.00");
  assert.equal(formatAmountDue(550), "$5.50");
  assert.equal(formatAmountDue(0), "$0.00");
  assert.equal(formatAmountDue(null), null);
  assert.equal(formatAmountDue("abc"), null);
  assert.equal(formatAmountDue(-100), null);
});

test("buildPaymentFailedEmail: subject, amount line, settings CTA, Replyr sign-off", () => {
  const { subject, text, html } = buildPaymentFailedEmail({
    accountId: "acct-1",
    amountDueCents: 1900,
    settingsUrl: "https://replyr.pro/connected?accountId=acct-1#settings"
  });
  assert.equal(subject, PAYMENT_FAILED_SUBJECT);
  assert.equal(subject, "Your Replyr payment failed — update your card to keep your replies on");
  assert.ok(text.includes("Amount due: $19.00."));
  assert.ok(text.includes("https://replyr.pro/connected?accountId=acct-1#settings"));
  assert.ok(text.trimEnd().endsWith("— Replyr"));
  assert.ok(html.includes("$19.00"));
});

test("buildPaymentFailedEmail: portal URL wins as CTA; amount omitted when unknown", () => {
  const { text, html } = buildPaymentFailedEmail({
    accountId: "acct-1",
    amountDueCents: null,
    billingUrl: "https://billing.stripe.com/p/session/abc",
    settingsUrl: "https://replyr.pro/connected?accountId=acct-1#settings"
  });
  assert.ok(text.includes("https://billing.stripe.com/p/session/abc"));
  assert.ok(!text.includes("Amount due"));
  assert.ok(html.includes('href="https://billing.stripe.com/p/session/abc"'));

  // A non-URL billingUrl value must not become the CTA.
  const fallback = buildPaymentFailedEmail({
    accountId: "acct-1",
    billingUrl: "not-a-url",
    settingsUrl: "https://replyr.pro/connected?accountId=acct-1#settings"
  });
  assert.ok(fallback.text.includes("#settings"));
  assert.ok(!fallback.text.includes("not-a-url"));
});

test("shouldSendPaymentFailed + patches: stamp suppresses, clear re-arms", () => {
  assert.equal(shouldSendPaymentFailed(null), false);
  assert.equal(shouldSendPaymentFailed({ dunningSentAt: null }), true);
  assert.equal(shouldSendPaymentFailed({ dunningSentAt: "2026-11-01T00:00:00Z" }), false);
  const stamp = dunningStampPatch(new Date("2026-11-11T12:00:00Z"));
  assert.deepEqual(stamp, { dunningSentAt: "2026-11-11T12:00:00.000Z" });
  assert.equal(shouldSendPaymentFailed({ ...business, ...stamp }), false);
  assert.deepEqual(dunningClearPatch(), { dunningSentAt: null });
  assert.equal(shouldSendPaymentFailed({ ...business, ...stamp, ...dunningClearPatch() }), true);
});

test("sendPaymentFailedEmail: uses STRIPE_CUSTOMER_PORTAL_URL from env when set", async () => {
  const sent = [];
  const result = await sendPaymentFailedEmail({
    to: "owner@example.com",
    business,
    amountDueCents: 3900,
    env: { RESEND_API_KEY: "k", BASE_URL: "https://replyr.pro", STRIPE_CUSTOMER_PORTAL_URL: "https://billing.stripe.com/p/x" },
    send: async (msg) => {
      sent.push(msg);
    },
    logger: { warn() {} }
  });
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes("https://billing.stripe.com/p/x"));
  assert.ok(sent[0].text.includes("$39.00"));
  assert.equal(sent[0].to[0], "owner@example.com");
});

test("handlePaymentFailed: sends once, stamps every location row only on success", async () => {
  const rows = [
    { ...business },
    { accountId: "acct-1", locationId: "loc-2", notificationEmail: "owner@example.com", dunningSentAt: null }
  ];
  const stamps = [];
  let sends = 0;
  const logger = { info() {}, warn() {} };
  const ok = await handlePaymentFailed({
    accountId: "acct-1",
    amountDueCents: 1900,
    logger,
    deps: {
      getBusinessesForAccount: async () => rows,
      sendPaymentFailedEmail: async () => {
        sends += 1;
        return { sent: true };
      },
      upsertBusiness: async (cfg) => {
        stamps.push(cfg);
      }
    }
  });
  assert.equal(ok.sent, true);
  assert.equal(sends, 1);
  assert.equal(stamps.length, 2);
  assert.ok(stamps.every((s) => typeof s.dunningSentAt === "string"));

  // Already stamped → no send, no stamp.
  const stampedRows = rows.map((r) => ({ ...r, dunningSentAt: "2026-11-10T00:00:00Z" }));
  const skipped = await handlePaymentFailed({
    accountId: "acct-1",
    logger,
    deps: {
      getBusinessesForAccount: async () => stampedRows,
      sendPaymentFailedEmail: async () => {
        throw new Error("must not be called");
      },
      upsertBusiness: async () => {
        throw new Error("must not stamp");
      }
    }
  });
  assert.deepEqual(skipped, { sent: false, reason: "already-sent" });

  // Send failure → no stamp.
  const stamps2 = [];
  const failed = await handlePaymentFailed({
    accountId: "acct-1",
    logger,
    deps: {
      getBusinessesForAccount: async () => rows,
      sendPaymentFailedEmail: async () => ({ sent: false, reason: "no-resend-key" }),
      upsertBusiness: async (cfg) => {
        stamps2.push(cfg);
      }
    }
  });
  assert.equal(failed.sent, false);
  assert.equal(stamps2.length, 0);

  // No notification email → silent skip.
  const noEmail = await handlePaymentFailed({
    accountId: "acct-1",
    logger,
    deps: {
      getBusinessesForAccount: async () => [{ ...business, notificationEmail: null }],
      sendPaymentFailedEmail: async () => ({ sent: true }),
      upsertBusiness: async () => {}
    }
  });
  assert.deepEqual(noEmail, { sent: false, reason: "no-recipient" });
});
