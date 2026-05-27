import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

delete process.env.DATABASE_URL;

const businessesPath = new URL("../businesses.json", import.meta.url);
const { getBusiness, getEnabledBusinesses, upsertBusiness } = await import("../src/businesses.js");

async function resetBusinessesFile() {
  await fs.rm(businessesPath, { force: true });
}

beforeEach(resetBusinessesFile);
after(resetBusinessesFile);

test("upsertBusiness preserves explicit nulls for subscription cancellation state", async () => {
  const accountId = "acct-cancelled-subscription";
  await upsertBusiness({
    accountId,
    locationId: "loc-1",
    name: "Cancelled Subscription Test",
    autoReplyEnabled: true,
    trialEndsAt: "2024-01-01T00:00:00.000Z",
    subscribedAt: "2026-01-01T00:00:00.000Z",
    stripeCustomerId: "cus_cancel_test",
    notificationEmail: "owner@example.com"
  });

  const existing = await getBusiness(accountId);
  await upsertBusiness({
    ...existing,
    subscribedAt: null,
    stripeCustomerId: null,
    notificationEmail: null,
    isPro: false
  });

  const updated = await getBusiness(accountId);
  assert.equal(updated.subscribedAt, null);
  assert.equal(updated.stripeCustomerId, null);
  assert.equal(updated.notificationEmail, null);
  assert.deepEqual(await getEnabledBusinesses(), []);
});
