import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREVIEW_WINDOW_DAYS,
  previewUntilFrom,
  isPreviewWindowActive,
  effectiveAutoReplyMode
} from "../src/replyDelay.js";

const CONNECTED = new Date("2026-11-05T12:00:00.000Z");
const UNTIL = previewUntilFrom(CONNECTED);
const INSIDE = new Date("2026-11-08T12:00:00.000Z"); // connect + 3 days
const OUTSIDE = new Date("2026-11-20T12:00:00.000Z"); // connect + 15 days

test("previewUntilFrom: exactly PREVIEW_WINDOW_DAYS after connect", () => {
  assert.equal(PREVIEW_WINDOW_DAYS, 7);
  assert.equal(UNTIL, "2026-11-12T12:00:00.000Z");
});

test("isPreviewWindowActive: inside, outside, and unset", () => {
  assert.equal(isPreviewWindowActive({ previewUntil: UNTIL }, INSIDE), true);
  assert.equal(isPreviewWindowActive({ previewUntil: UNTIL }, OUTSIDE), false);
  assert.equal(isPreviewWindowActive({ previewUntil: null }, INSIDE), false);
  assert.equal(isPreviewWindowActive({}, INSIDE), false);
  assert.equal(isPreviewWindowActive(null, INSIDE), false);
  assert.equal(isPreviewWindowActive({ previewUntil: "not-a-date" }, INSIDE), false);
});

test("effectiveAutoReplyMode: saved 'delayed' always wins", () => {
  assert.equal(effectiveAutoReplyMode({ autoReplyMode: "delayed" }, OUTSIDE), "delayed");
  assert.equal(
    effectiveAutoReplyMode({ autoReplyMode: "delayed", previewUntil: UNTIL, previewChoice: "off" }, INSIDE),
    "delayed"
  );
});

test("effectiveAutoReplyMode: inside the window -> delayed by default", () => {
  assert.equal(effectiveAutoReplyMode({ autoReplyMode: "instant", previewUntil: UNTIL }, INSIDE), "delayed");
  assert.equal(
    effectiveAutoReplyMode({ autoReplyMode: "instant", previewUntil: UNTIL, previewChoice: "keep" }, INSIDE),
    "delayed"
  );
  assert.equal(effectiveAutoReplyMode({ previewUntil: UNTIL }, INSIDE), "delayed");
});

test("effectiveAutoReplyMode: explicit 'off' choice beats the window", () => {
  assert.equal(
    effectiveAutoReplyMode({ autoReplyMode: "instant", previewUntil: UNTIL, previewChoice: "off" }, INSIDE),
    "instant"
  );
});

test("effectiveAutoReplyMode: after the window the saved mode rules", () => {
  assert.equal(effectiveAutoReplyMode({ autoReplyMode: "instant", previewUntil: UNTIL }, OUTSIDE), "instant");
  assert.equal(effectiveAutoReplyMode({ autoReplyMode: "instant" }, INSIDE), "instant");
  assert.equal(effectiveAutoReplyMode({}, INSIDE), "instant");
});
