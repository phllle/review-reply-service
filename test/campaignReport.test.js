import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCampaignReportEmail } from "../src/campaignReport.js";

test("buildCampaignReportEmail: reports email + SMS counts and quota", () => {
  const { subject, text, html } = buildCampaignReportEmail({
    businessName: "Castle Nail Bar",
    campaignLabel: "Mothers Day campaign",
    stats: { contactsTotal: 150, emailSent: 148, smsSent: 92, smsAttempted: 95, smsFailed: 3 },
    quota: { included: 500, used: 300, remaining: 200 },
    manageUrl: "https://replyr.pro/connected?accountId=x"
  });
  assert.match(subject, /240 messages out/); // 148 + 92
  assert.match(text, /Castle Nail Bar/);
  assert.match(text, /148 emails sent/);
  assert.match(text, /92 SMS sent/);
  assert.match(text, /3 SMS not sent/);
  assert.match(text, /300 of 500 used · 200 remaining/);
  assert.match(html, /Manage your account/);
});

test("buildCampaignReportEmail: omits quota block when SMS not used", () => {
  const { text } = buildCampaignReportEmail({
    businessName: "X",
    campaignLabel: "Promo",
    stats: { contactsTotal: 40, emailSent: 40, smsSent: 0, smsAttempted: 0, smsFailed: 0 },
    quota: null,
    manageUrl: "https://replyr.pro/connected?accountId=x"
  });
  assert.doesNotMatch(text, /SMS this month/);
  assert.match(text, /40 emails sent/);
});

test("buildCampaignReportEmail: flags exhausted quota", () => {
  const { text } = buildCampaignReportEmail({
    businessName: "X",
    campaignLabel: "Promo",
    stats: { contactsTotal: 600, emailSent: 600, smsSent: 500, smsAttempted: 600, smsFailed: 100 },
    quota: { included: 500, used: 500, remaining: 0 },
    manageUrl: "https://replyr.pro/connected?accountId=x"
  });
  assert.match(text, /100 SMS not sent/);
  assert.match(text, /monthly SMS limit/i);
});

test("buildCampaignReportEmail: singular grammar for one message", () => {
  const { subject, text } = buildCampaignReportEmail({
    businessName: "X",
    campaignLabel: "Promo",
    stats: { contactsTotal: 1, emailSent: 1, smsSent: 0, smsAttempted: 0, smsFailed: 0 },
    quota: null,
    manageUrl: "u"
  });
  assert.match(subject, /1 message out/);
  assert.match(text, /1 email sent/);
});
