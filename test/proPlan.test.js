import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRO_SMS_TIERS,
  normalizeProTier,
  getIncludedSmsForTier,
  getCurrentMonthKey
} from "../src/proPlan.js";

test("normalizeProTier: passthrough valid tiers", () => {
  assert.equal(normalizeProTier("starter"), "starter");
  assert.equal(normalizeProTier("growth"), "growth");
  assert.equal(normalizeProTier("scale"), "scale");
});

test("normalizeProTier: case-insensitive and trims", () => {
  assert.equal(normalizeProTier(" GROWTH "), "growth");
  assert.equal(normalizeProTier("Scale"), "scale");
});

test("normalizeProTier: unknown -> starter (safe default)", () => {
  assert.equal(normalizeProTier("enterprise"), "starter");
  assert.equal(normalizeProTier(""), "starter");
  assert.equal(normalizeProTier(null), "starter");
  assert.equal(normalizeProTier(undefined), "starter");
});

test("getIncludedSmsForTier matches the public tier table", () => {
  assert.equal(getIncludedSmsForTier("starter"), PRO_SMS_TIERS.starter.includedSms);
  assert.equal(getIncludedSmsForTier("growth"), PRO_SMS_TIERS.growth.includedSms);
  assert.equal(getIncludedSmsForTier("scale"), PRO_SMS_TIERS.scale.includedSms);
  assert.equal(getIncludedSmsForTier("bogus"), PRO_SMS_TIERS.starter.includedSms);
});

test("getCurrentMonthKey: zero-pads month and uses UTC", () => {
  // Use UTC explicitly so this test is timezone-stable.
  const jan = new Date(Date.UTC(2026, 0, 15));
  assert.equal(getCurrentMonthKey(jan), "2026-01");
  const dec = new Date(Date.UTC(2026, 11, 31, 23, 59));
  assert.equal(getCurrentMonthKey(dec), "2026-12");
});

test("getCurrentMonthKey: late-PT crossing into next UTC month rolls month forward", () => {
  // 2026-01-31 23:30 PT == 2026-02-01 07:30 UTC. Function uses UTC -> "2026-02".
  // This test pins the contract: SMS quotas reset at UTC midnight, not Pacific.
  const ptLateMonth = new Date("2026-02-01T07:30:00Z");
  assert.equal(getCurrentMonthKey(ptLateMonth), "2026-02");
});
