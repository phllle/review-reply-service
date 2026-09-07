import { test } from "node:test";
import assert from "node:assert/strict";

const { buildMessage, buildEmail } = await import("../src/reviewRequests.js");

const url = "https://search.google.com/local/writereview?placeid=ChIJ";

test("SMS copy: rating-neutral, keeps STOP, no star solicitation", () => {
  const m = buildMessage("Maria", "Castle Nail Bar", url);
  assert.doesNotMatch(m, /5[- ]star/i);
  assert.doesNotMatch(m, /five star/i);
  assert.doesNotMatch(m, /high rating/i);
  assert.match(m, /Reply STOP to opt out\./);
  assert.match(m, /google review/i);
});

test("email copy: rating-neutral, no star solicitation", () => {
  const { subject, bodyContent } = buildEmail("Maria", "Castle Nail Bar", url);
  const all = subject + "\n" + bodyContent;
  assert.doesNotMatch(all, /5[- ]star/i);
  assert.doesNotMatch(all, /five star/i);
  assert.doesNotMatch(all, /high rating/i);
  assert.match(bodyContent, /google review/i);
});
