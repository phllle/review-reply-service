import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WELCOME_SUBJECT,
  FIRST_REPLY_SUBJECT,
  buildWelcomeEmail,
  buildFirstReplyEmail,
  starsLabel,
  settingsUrlFor,
  sendWelcomeEmail
} from "../src/onboardingEmails.js";

test("settingsUrlFor: points at the connected page's settings anchor", () => {
  assert.equal(
    settingsUrlFor("123", { BASE_URL: "https://replyr.pro/" }),
    "https://replyr.pro/connected?accountId=123#settings"
  );
});

test("buildWelcomeEmail: kit subject and the five numbered promises", () => {
  const { subject, text, html } = buildWelcomeEmail({ accountId: "123" });
  assert.equal(subject, WELCOME_SUBJECT);
  assert.equal(subject, "You're connected — here's exactly what Replyr will do");
  for (const snippet of [
    "precisely what happens next, no surprises",
    "Your first 5 replies are free.",
    "New reviews get replies automatically",
    "Low-star reviews wait for you first.",
    "You're always in control.",
    "Your trial runs 30 days.",
    "— Replyr"
  ]) {
    assert.ok(text.includes(snippet), `text missing: ${snippet}`);
    assert.ok(html.includes(snippet.replace(/^(\d+\. )/, "")), `html missing: ${snippet}`);
  }
  assert.ok(text.includes("/connected?accountId=123#settings"));
  assert.ok(!text.includes("Phillip"));
});

test("starsLabel: full/empty stars for 1..5, blank otherwise", () => {
  assert.equal(starsLabel(5), "★★★★★");
  assert.equal(starsLabel(2), "★★☆☆☆");
  assert.equal(starsLabel(0), "");
  assert.equal(starsLabel(null), "");
  assert.equal(starsLabel("FIVE"), "");
});

test("buildFirstReplyEmail: fills reviewer, stars, review and reply", () => {
  const { subject, text, html } = buildFirstReplyEmail({
    reviewerName: "Maria K.",
    rating: 5,
    reviewText: "Waited a bit but they fixed my crown the same week.",
    replyText: "Thank you, Maria!",
    reviewUrl: "https://www.google.com/maps/place/?q=place_id:abc",
    settingsUrl: "https://replyr.pro/connected?accountId=1#settings"
  });
  assert.equal(subject, FIRST_REPLY_SUBJECT);
  assert.equal(subject, "Your first Replyr reply just posted");
  assert.ok(text.includes('Maria K. ★★★★★ — "Waited a bit but they fixed my crown the same week."'));
  assert.ok(text.includes('Your reply (as Owner): "Thank you, Maria!"'));
  assert.ok(text.includes("https://www.google.com/maps/place/?q=place_id:abc"));
  assert.ok(text.includes("https://replyr.pro/connected?accountId=1#settings"));
  assert.ok(html.includes("Maria K."));
  assert.ok(text.endsWith("— Replyr"));
});

test("buildFirstReplyEmail: escapes HTML in review content", () => {
  const { html } = buildFirstReplyEmail({
    reviewerName: "<script>alert(1)</script>",
    rating: 1,
    reviewText: "a < b",
    replyText: "ok",
    reviewUrl: "",
    settingsUrl: ""
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("a &lt; b"));
});

test("sendWelcomeEmail: no recipient / no key are soft failures", async () => {
  assert.deepEqual(await sendWelcomeEmail({ to: "", accountId: "1", logger: null }), {
    sent: false,
    reason: "no-recipient"
  });
  assert.deepEqual(await sendWelcomeEmail({ to: "a@b.c", accountId: "1", logger: null, env: {} }), {
    sent: false,
    reason: "no-resend-key"
  });
  const sent = await sendWelcomeEmail({
    to: "a@b.c",
    accountId: "1",
    logger: null,
    env: {},
    send: async (msg) => {
      assert.equal(msg.subject, WELCOME_SUBJECT);
      assert.deepEqual(msg.to, ["a@b.c"]);
    }
  });
  assert.deepEqual(sent, { sent: true });
});
