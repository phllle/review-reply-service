import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildProEventCampaignUpsertData,
  isSentProEventCampaign,
  normalizeEventSendAtLocal
} from "../src/proEventCampaignUpdate.js";

test("isSentProEventCampaign detects sent campaigns", () => {
  assert.equal(isSentProEventCampaign({ sentAt: "2026-06-03T10:00:00.000Z" }), true);
  assert.equal(isSentProEventCampaign({ sentAt: null }), false);
  assert.equal(isSentProEventCampaign(null), false);
});

test("buildProEventCampaignUpsertData preserves saved fields on partial status update", () => {
  const existing = {
    status: "confirmed",
    messageText: "Existing message {{offer}}",
    offerText: "10% off",
    sendAtLocal: "2026-07-01T09:30",
    sendEmail: true,
    sendSms: false,
    confirmedAt: "2026-06-01T00:00:00.000Z",
    sentAt: null
  };

  const data = buildProEventCampaignUpsertData(existing, { status: "skipped" });

  assert.deepEqual(data, {
    status: "skipped",
    messageText: existing.messageText,
    offerText: existing.offerText,
    sendAtLocal: existing.sendAtLocal,
    sendEmail: true,
    sendSms: false,
    confirmedAt: null,
    sentAt: null
  });
});

test("buildProEventCampaignUpsertData keeps an existing send time when reconfirming", () => {
  const now = new Date("2026-06-03T11:00:00.000Z");
  const data = buildProEventCampaignUpsertData(
    {
      status: "confirmed",
      messageText: "Old",
      offerText: "",
      sendAtLocal: "2026-07-04T08:00",
      sendEmail: true,
      sendSms: true,
      sentAt: null
    },
    { status: "confirmed", messageText: "Updated" },
    now
  );

  assert.equal(data.status, "confirmed");
  assert.equal(data.messageText, "Updated");
  assert.equal(data.sendAtLocal, "2026-07-04T08:00");
  assert.equal(data.confirmedAt, now.toISOString());
});

test("normalizeEventSendAtLocal accepts only local minute timestamps", () => {
  assert.equal(normalizeEventSendAtLocal(" 2026-07-04T08:00 "), "2026-07-04T08:00");
  assert.equal(normalizeEventSendAtLocal("2026-07-04"), null);
  assert.equal(normalizeEventSendAtLocal("not a date"), null);
});
