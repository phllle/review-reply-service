import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FREE_REPLIES_NUDGE_SUBJECT,
  WINBACK_OFF_SUBJECT,
  buildFreeRepliesNudgeEmail,
  buildTrialEndingEmail,
  buildWinbackEmail,
  trialEndingSubject,
  selectLifecycleEmails,
  trialStartedAt,
  daysUntil,
  formatShortDate,
  formatLongDate,
  subscriptionPeriodEndSeconds,
  cancellationPatchFromSubscription,
  isLifecycleSendWindow,
  runLifecycleEmails
} from "../src/lifecycleEmails.js";
import { mergeBusinessUpsert } from "../src/businesses.js";

const NOW = new Date("2026-11-11T18:00:00Z"); // Wed Nov 11, 10:00 PST
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function trialBiz(overrides = {}) {
  return {
    accountId: "acct-1",
    locationId: "loc-1",
    name: "Trial Biz",
    notificationEmail: "owner@example.com",
    subscribedAt: null,
    isPro: false,
    freeRepliesUsed: 0,
    signupAt: iso(NOW.getTime() - 10 * DAY),
    trialEndsAt: iso(NOW.getTime() + 20 * DAY),
    trialNudgeSentAt: null,
    trialEndingSentAt: null,
    winbackSentAt: null,
    subCancelledAt: null,
    subAccessEndsAt: null,
    ...overrides
  };
}

const pickTypes = (businesses, now = NOW) => selectLifecycleEmails(businesses, now).map((p) => p.type);

// --- Selection: free_replies_nudge ---------------------------------------------

test("select: nudge fires for mid-trial account with free replies left", () => {
  assert.deepEqual(pickTypes([trialBiz({ freeRepliesUsed: 2 })]), ["free_replies_nudge"]);
});

test("select: nudge fires at exactly 2 days after trial start", () => {
  const biz = trialBiz({ signupAt: iso(NOW.getTime() - 2 * DAY), trialEndsAt: iso(NOW.getTime() + 28 * DAY) });
  assert.deepEqual(pickTypes([biz]), ["free_replies_nudge"]);
});

test("select: nudge held before day 2, when all free replies used, when stamped, when trial over", () => {
  assert.deepEqual(pickTypes([trialBiz({ signupAt: iso(NOW.getTime() - 1 * DAY), trialEndsAt: iso(NOW.getTime() + 29 * DAY) })]), []);
  assert.deepEqual(pickTypes([trialBiz({ freeRepliesUsed: 5 })]), []);
  assert.deepEqual(pickTypes([trialBiz({ trialNudgeSentAt: iso(NOW.getTime() - DAY) })]), []);
  assert.deepEqual(pickTypes([trialBiz({ trialEndsAt: iso(NOW.getTime() - DAY) })]), []);
});

test("select: nudge derives trial start as trialEndsAt - 30d when signupAt is missing", () => {
  const biz = trialBiz({ signupAt: null, trialEndsAt: iso(NOW.getTime() + 25 * DAY) }); // started 5 days ago
  assert.deepEqual(pickTypes([biz]), ["free_replies_nudge"]);
  const fresh = trialBiz({ signupAt: null, trialEndsAt: iso(NOW.getTime() + 29 * DAY) }); // started 1 day ago
  assert.deepEqual(pickTypes([fresh]), []);
});

test("trialStartedAt: prefers signupAt, falls back to trialEndsAt - 30d", () => {
  assert.equal(trialStartedAt({ signupAt: "2026-11-01T00:00:00Z", trialEndsAt: "2026-12-05T00:00:00Z" }).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(trialStartedAt({ signupAt: null, trialEndsAt: "2026-12-05T00:00:00Z" }).toISOString(), "2026-11-05T00:00:00.000Z");
  assert.equal(trialStartedAt({}), null);
});

// --- Selection: trial_ending -----------------------------------------------------

test("select: trial_ending fires inside the 3-day window and outranks the nudge", () => {
  const biz = trialBiz({ trialEndsAt: iso(NOW.getTime() + 2 * DAY), freeRepliesUsed: 0 });
  assert.deepEqual(pickTypes([biz]), ["trial_ending"]);
});

test("select: trial_ending window edges — exactly +3d fires, +3d1h does not", () => {
  assert.deepEqual(pickTypes([trialBiz({ trialEndsAt: iso(NOW.getTime() + 3 * DAY) })]), ["trial_ending"]);
  const justOutside = trialBiz({
    trialEndsAt: iso(NOW.getTime() + 3 * DAY + 60 * 60 * 1000),
    trialNudgeSentAt: iso(NOW.getTime() - DAY) // isolate from the nudge
  });
  assert.deepEqual(pickTypes([justOutside]), []);
  const justEnded = trialBiz({ trialEndsAt: iso(NOW.getTime() - 60 * 1000), trialNudgeSentAt: iso(NOW.getTime() - DAY) });
  assert.deepEqual(pickTypes([justEnded]), []);
});

test("select: trial_ending stamp prevents a re-send", () => {
  const biz = trialBiz({
    trialEndsAt: iso(NOW.getTime() + 2 * DAY),
    trialEndingSentAt: iso(NOW.getTime() - DAY),
    trialNudgeSentAt: iso(NOW.getTime() - DAY)
  });
  assert.deepEqual(pickTypes([biz]), []);
});

test("select: subscribed and Pro accounts never get trial emails", () => {
  const endingSoon = { trialEndsAt: iso(NOW.getTime() + 2 * DAY) };
  assert.deepEqual(pickTypes([trialBiz({ ...endingSoon, subscribedAt: iso(NOW.getTime() - 40 * DAY) })]), []);
  assert.deepEqual(pickTypes([trialBiz({ ...endingSoon, isPro: true })]), []);
});

// --- Selection: winback ------------------------------------------------------------

test("select: winback fires for a cancelled account, even while still subscribed in the grace period", () => {
  const biz = trialBiz({
    subscribedAt: iso(NOW.getTime() - 90 * DAY),
    trialEndsAt: null,
    subCancelledAt: iso(NOW.getTime() - DAY),
    subAccessEndsAt: iso(NOW.getTime() + 9 * DAY)
  });
  assert.deepEqual(pickTypes([biz]), ["winback"]);
});

test("select: winback stamp prevents a re-send; winback outranks trial picks", () => {
  // Nudge stamped too, to isolate the winback rule from the trial rules.
  const stamped = trialBiz({
    subCancelledAt: iso(NOW.getTime() - DAY),
    winbackSentAt: iso(NOW.getTime() - 12 * 60 * 60 * 1000),
    trialNudgeSentAt: iso(NOW.getTime() - DAY)
  });
  assert.deepEqual(pickTypes([stamped]), []);
  const both = trialBiz({ subCancelledAt: iso(NOW.getTime() - DAY), trialEndsAt: iso(NOW.getTime() + 2 * DAY) });
  assert.deepEqual(pickTypes([both]), ["winback"]);
});

test("select: one pick per account even with multiple location rows", () => {
  const rows = [trialBiz({ locationId: "loc-1" }), trialBiz({ locationId: "loc-2" })];
  const picks = selectLifecycleEmails(rows, NOW);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].accountId, "acct-1");
});

// --- Builders ------------------------------------------------------------------------

test("buildFreeRepliesNudgeEmail: subject, used/remaining counts, settings link, sign-off", () => {
  const { subject, text, html } = buildFreeRepliesNudgeEmail({ accountId: "123", freeRepliesUsed: 2 });
  assert.equal(subject, FREE_REPLIES_NUDGE_SUBJECT);
  assert.equal(subject, "You still have free review replies waiting");
  assert.ok(text.includes("you've used 2 of your 5 free Replyr trial replies"));
  assert.ok(text.includes("3 are still waiting"));
  assert.ok(text.includes("No card needed during the trial"));
  assert.ok(text.includes("/connected?accountId=123#settings"));
  assert.ok(text.includes("— Replyr"));
  assert.ok(!text.includes("Phillip"));
  assert.ok(html.includes("3 are still waiting"));
  const one = buildFreeRepliesNudgeEmail({ accountId: "123", freeRepliesUsed: 4 });
  assert.ok(one.text.includes("1 is still waiting"));
});

test("buildTrialEndingEmail: computed day count in subject, end date and price in body", () => {
  const endsAt = iso(NOW.getTime() + 2.5 * DAY); // ceil -> 3 days
  const { subject, text, html } = buildTrialEndingEmail({ accountId: "123", trialEndsAt: endsAt, now: NOW });
  assert.equal(subject, "Your Replyr trial ends in 3 days");
  assert.equal(subject, trialEndingSubject(3));
  assert.ok(text.includes(formatLongDate(endsAt)));
  assert.ok(text.includes("automatic replies stop"));
  assert.ok(text.includes("sit unanswered"));
  assert.ok(text.includes("$19/month"));
  assert.ok(text.includes("/connected?accountId=123#settings"));
  assert.ok(text.includes("— Replyr"));
  assert.ok(html.includes("$19/month"));
  const oneDay = buildTrialEndingEmail({ accountId: "123", trialEndsAt: iso(NOW.getTime() + 12 * 60 * 60 * 1000), now: NOW });
  assert.equal(oneDay.subject, "Your Replyr trial ends in 1 day");
});

test("daysUntil: rounds up, floors at 0, null on garbage", () => {
  assert.equal(daysUntil(iso(NOW.getTime() + 2.5 * DAY), NOW), 3);
  assert.equal(daysUntil(iso(NOW.getTime() - DAY), NOW), 0);
  assert.equal(daysUntil("not-a-date", NOW), null);
  assert.equal(daysUntil(null, NOW), null);
});

test("buildWinbackEmail: future access end -> turn-off date subject and re-enable copy", () => {
  const accessEndsAt = "2026-11-20T00:00:00Z";
  const { subject, text, html } = buildWinbackEmail({ accountId: "123", accessEndsAt, now: NOW });
  assert.equal(subject, "Your review replies turn off on Nov 20");
  assert.equal(subject, `Your review replies turn off on ${formatShortDate(accessEndsAt)}`);
  assert.ok(text.includes(`set to end on ${formatLongDate(accessEndsAt)}`));
  assert.ok(text.includes("Re-enable in two clicks"));
  assert.ok(text.includes("/connected?accountId=123#settings"));
  assert.ok(text.includes("— Replyr"));
  assert.ok(html.includes("Re-enable in two clicks"));
});

test("buildWinbackEmail: past or absent access end -> auto-reply is off variant", () => {
  const past = buildWinbackEmail({ accountId: "123", accessEndsAt: "2026-11-01T00:00:00Z", now: NOW });
  assert.equal(past.subject, WINBACK_OFF_SUBJECT);
  assert.equal(past.subject, "Your Replyr auto-reply is off");
  assert.ok(past.text.includes("new Google reviews are going unanswered"));
  assert.ok(past.text.includes("Re-enable anytime"));
  const absent = buildWinbackEmail({ accountId: "123", accessEndsAt: null, now: NOW });
  assert.equal(absent.subject, WINBACK_OFF_SUBJECT);
});

// --- Stripe cancellation mapping -------------------------------------------------------

test("subscriptionPeriodEndSeconds: top-level first, items fallback, null when absent", () => {
  assert.equal(subscriptionPeriodEndSeconds({ current_period_end: 1795000000 }), 1795000000);
  assert.equal(subscriptionPeriodEndSeconds({ items: { data: [{ current_period_end: 1795000000 }] } }), 1795000000);
  assert.equal(
    subscriptionPeriodEndSeconds({ current_period_end: 1795000000, items: { data: [{ current_period_end: 1796000000 }] } }),
    1795000000
  );
  assert.equal(subscriptionPeriodEndSeconds({}), null);
  assert.equal(subscriptionPeriodEndSeconds(null), null);
});

test("cancellationPatch: cancel_at_period_end records cancel time and period end", () => {
  const endSec = Math.floor((NOW.getTime() + 9 * DAY) / 1000);
  const patch = cancellationPatchFromSubscription({
    subscription: { cancel_at_period_end: true, current_period_end: endSec, status: "active" },
    business: {},
    now: NOW
  });
  assert.equal(patch.subCancelledAt, NOW.toISOString());
  assert.equal(patch.subAccessEndsAt, new Date(endSec * 1000).toISOString());
});

test("cancellationPatch: earliest cancel stamp wins; items period end is used when top-level moved", () => {
  const endSec = Math.floor((NOW.getTime() + 9 * DAY) / 1000);
  const patch = cancellationPatchFromSubscription({
    subscription: { cancel_at_period_end: true, items: { data: [{ current_period_end: endSec }] }, status: "active" },
    business: { subCancelledAt: "2026-11-01T00:00:00.000Z" },
    now: NOW
  });
  assert.equal(patch.subCancelledAt, "2026-11-01T00:00:00.000Z");
  assert.equal(patch.subAccessEndsAt, new Date(endSec * 1000).toISOString());
});

test("cancellationPatch: un-cancelling while active clears state and the winback stamp", () => {
  const patch = cancellationPatchFromSubscription({
    subscription: { cancel_at_period_end: false, status: "active" },
    business: { subCancelledAt: "2026-11-01T00:00:00.000Z", winbackSentAt: "2026-11-02T00:00:00.000Z" },
    now: NOW
  });
  assert.deepEqual(patch, { subCancelledAt: null, subAccessEndsAt: null, winbackSentAt: null });
});

test("cancellationPatch: no change for other statuses or missing subscription", () => {
  assert.equal(cancellationPatchFromSubscription({ subscription: { cancel_at_period_end: false, status: "past_due" }, business: {}, now: NOW }), null);
  assert.equal(cancellationPatchFromSubscription({ subscription: null, business: {}, now: NOW }), null);
});

// --- Send window ------------------------------------------------------------------------

test("isLifecycleSendWindow: 9:00-17:59 America/Los_Angeles only", () => {
  assert.equal(isLifecycleSendWindow(new Date("2026-11-11T17:00:00Z")), true); // 09:00 PST
  assert.equal(isLifecycleSendWindow(new Date("2026-11-11T16:59:00Z")), false); // 08:59 PST
  assert.equal(isLifecycleSendWindow(new Date("2026-11-12T01:59:00Z")), true); // 17:59 PST
  assert.equal(isLifecycleSendWindow(new Date("2026-11-12T02:00:00Z")), false); // 18:00 PST
  assert.equal(isLifecycleSendWindow(new Date("2026-11-11T11:00:00Z")), false); // 03:00 PST
});

// --- Runner --------------------------------------------------------------------------------

test("runLifecycleEmails: sends the nudge and stamps every location row on success", async () => {
  const rows = [
    trialBiz({ locationId: "loc-1", freeRepliesUsed: 1 }),
    trialBiz({ locationId: "loc-2", freeRepliesUsed: 1 })
  ];
  const sentMessages = [];
  const stamps = [];
  const result = await runLifecycleEmails(
    { info() {}, warn() {}, error() {} },
    {
      now: NOW,
      deps: {
        getAllBusinesses: async () => ({ "acct-1::loc-1": rows[0], "acct-1::loc-2": rows[1] }),
        getBusinessesForAccount: async () => rows,
        upsertBusiness: async (patch) => {
          stamps.push(patch);
        },
        send: async (message) => {
          sentMessages.push(message);
        },
        env: {}
      }
    }
  );
  assert.equal(result.sent, 1);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0].to, ["owner@example.com"]);
  assert.equal(sentMessages[0].subject, FREE_REPLIES_NUDGE_SUBJECT);
  assert.ok(sentMessages[0].text.includes("you've used 1 of your 5"));
  assert.equal(stamps.length, 2);
  assert.ok(stamps.every((s) => s.trialNudgeSentAt === NOW.toISOString()));
  assert.deepEqual(
    stamps.map((s) => s.locationId).sort(),
    ["loc-1", "loc-2"]
  );
});

test("runLifecycleEmails: skips silently without a notification email; nothing stamped", async () => {
  const biz = trialBiz({ notificationEmail: null });
  let sendCalls = 0;
  let stampCalls = 0;
  const result = await runLifecycleEmails(
    { info() {}, warn() {}, error() {} },
    {
      now: NOW,
      deps: {
        getAllBusinesses: async () => ({ "acct-1::loc-1": biz }),
        getBusinessesForAccount: async () => [biz],
        upsertBusiness: async () => {
          stampCalls += 1;
        },
        send: async () => {
          sendCalls += 1;
        },
        env: {}
      }
    }
  );
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(sendCalls, 0);
  assert.equal(stampCalls, 0);
});

test("runLifecycleEmails: outside the PT window it does nothing", async () => {
  const result = await runLifecycleEmails(
    { info() {}, warn() {}, error() {} },
    {
      now: new Date("2026-11-11T11:00:00Z"), // 03:00 PST
      deps: {
        getAllBusinesses: async () => {
          throw new Error("must not be called outside the window");
        }
      }
    }
  );
  assert.deepEqual(result, { sent: 0, skipped: 0, reason: "outside-window" });
});

// --- Business merge passthrough ---------------------------------------------------------------

test("mergeBusinessUpsert: lifecycle/cancel fields survive merges and inherit to new locations", () => {
  const map = {
    "acct-1::loc-1": trialBiz({ subCancelledAt: "2026-11-01T00:00:00.000Z" })
  };
  const stamped = mergeBusinessUpsert(map, {
    accountId: "acct-1",
    locationId: "loc-1",
    trialNudgeSentAt: "2026-11-11T18:00:00.000Z"
  });
  assert.equal(stamped.trialNudgeSentAt, "2026-11-11T18:00:00.000Z");
  assert.equal(stamped.subCancelledAt, "2026-11-01T00:00:00.000Z");
  const newLocation = mergeBusinessUpsert(map, { accountId: "acct-1", locationId: "loc-2" });
  assert.equal(newLocation.subCancelledAt, "2026-11-01T00:00:00.000Z");
});
