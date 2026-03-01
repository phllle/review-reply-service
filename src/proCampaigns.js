/**
 * Replyr Pro: campaign logic – events calendar, birthday-today filter, send helpers.
 * Requires DB (db.useDb()).
 */

import * as db from "./db.js";
import { sendCampaignEmail } from "./campaignEmail.js";
import { getBusiness } from "./businesses.js";

// Major US events: key, name, and a function (year) -> send date (YYYY-MM-DD)
const EVENT_RULES = [
  { key: "valentines_day", name: "Valentine's Day", getDate: (y) => `${y}-02-14` },
  { key: "presidents_day", name: "Presidents Day", getDate: (y) => getNthWeekdayInMonth(y, 2, 1, 1) }, // 3rd Mon Feb
  { key: "lunar_new_year", name: "Lunar New Year", getDate: (y) => lunarNewYear(y) },
  { key: "easter", name: "Easter", getDate: (y) => easter(y) },
  { key: "mothers_day", name: "Mothers Day", getDate: (y) => getNthWeekdayInMonth(y, 5, 0, 2) }, // 2nd Sun May
  { key: "memorial_day", name: "Memorial Day", getDate: (y) => getLastWeekdayInMonth(y, 5, 1) },
  { key: "fathers_day", name: "Fathers Day", getDate: (y) => getNthWeekdayInMonth(y, 6, 0, 3) },
  { key: "independence_day", name: "Independence Day", getDate: (y) => `${y}-07-04` },
  { key: "labor_day", name: "Labor Day", getDate: (y) => getNthWeekdayInMonth(y, 9, 1, 1) },
  { key: "halloween", name: "Halloween", getDate: (y) => `${y}-10-31` },
  { key: "thanksgiving", name: "Thanksgiving", getDate: (y) => getNthWeekdayInMonth(y, 11, 4, 4) },
  { key: "black_friday", name: "Black Friday", getDate: (y) => dayAfterThanksgiving(y) },
  { key: "christmas", name: "Christmas", getDate: (y) => `${y}-12-25` },
  { key: "new_year", name: "New Year", getDate: (y) => `${y}-01-01` }
];

function getNthWeekdayInMonth(year, month, dayOfWeek, n) {
  // dayOfWeek 0=Sun, 1=Mon, ...
  let d = new Date(year, month - 1, 1);
  let count = 0;
  while (d.getMonth() === month - 1) {
    if (d.getDay() === dayOfWeek) {
      count++;
      if (count === n) return d.toISOString().slice(0, 10);
    }
    d.setDate(d.getDate() + 1);
  }
  return null;
}

function getLastWeekdayInMonth(year, month, dayOfWeek) {
  let d = new Date(year, month, 0);
  while (d.getDay() !== dayOfWeek) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function dayAfterThanksgiving(year) {
  const th = getNthWeekdayInMonth(year, 11, 4, 4);
  if (!th) return null;
  const d = new Date(th);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const d2 = new Date(year, month - 1, day);
  return d2.toISOString().slice(0, 10);
}

function lunarNewYear(year) {
  // Approximate: usually late Jan / early Feb
  const approx = new Date(year, 0, 21);
  const day = approx.getDate() + ((year - 2024) % 12) * 2;
  approx.setDate(Math.min(28, day));
  return approx.toISOString().slice(0, 10);
}

/** Get send date (YYYY-MM-DD) for an event in a given year. */
export function getEventSendDate(eventKey, eventYear) {
  const rule = EVENT_RULES.find((e) => e.key === eventKey);
  return rule ? rule.getDate(eventYear) : null;
}

/** Get upcoming events with send date and prompt date (2 weeks before). */
export function getUpcomingEvents(withinDays = 90) {
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + withinDays);
  const year = today.getFullYear();
  const out = [];
  for (const rule of EVENT_RULES) {
    const sendDate = rule.getDate(year);
    if (!sendDate) continue;
    const d = new Date(sendDate);
    if (d < today) {
      const nextYear = rule.getDate(year + 1);
      if (nextYear) out.push({ key: rule.key, name: rule.name, sendDate: nextYear, promptDate: addDays(nextYear, -14) });
    } else if (d <= end) {
      out.push({ key: rule.key, name: rule.name, sendDate, promptDate: addDays(sendDate, -14) });
    }
  }
  out.sort((a, b) => a.sendDate.localeCompare(b.sendDate));
  return out;
}

function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Given event date (YYYY-MM-DD) and send_days_before, return the date we should send (event date minus days). */
export function getSendDateForEvent(eventDateIso, sendDaysBefore = 14) {
  return addDays(eventDateIso, -Number(sendDaysBefore));
}

/** Parse birthday string (YYYY-MM-DD or MM-DD or MM/DD) to { month, day }. */
function parseBirthday(birthday) {
  if (!birthday || typeof birthday !== "string") return null;
  const s = birthday.trim().replace(/\//g, "-");
  const parts = s.split("-");
  if (parts.length >= 2) {
    const month = parseInt(parts[0], 10);
    const day = parseInt(parts[parts.length - 1], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { month, day };
  }
  return null;
}

/** Check if birthday (month, day) is today. */
function isBirthdayToday(month, day) {
  const t = new Date();
  return t.getMonth() + 1 === month && t.getDate() === day;
}

/** Get contacts whose birthday is today (month/day match). */
export function filterContactsWithBirthdayToday(contacts) {
  return contacts.filter((c) => {
    const b = parseBirthday(c.birthday);
    return b && isBirthdayToday(b.month, b.day);
  });
}

/** Personalize message: replace {{first_name}} and {{offer}}. */
export function personalizeBirthdayMessage(messageText, offerText, firstName) {
  let s = (messageText || "").replace(/\{\{first_name\}\}/gi, firstName || "there").replace(/\{\{name\}\}/gi, firstName || "there");
  s = s.replace(/\{\{offer\}\}/gi, offerText || "");
  return s;
}

/** Send birthday emails for one business (called by scheduler). */
export async function sendBirthdayCampaignsForAccount(accountId, logger = console) {
  if (!db.useDb()) return { sent: 0 };
  const settings = await db.getProBirthdaySettings(accountId);
  if (!settings || !settings.enabled || !settings.messageText) return { sent: 0 };
  const business = await getBusiness(accountId);
  if (!business?.isPro) return { sent: 0 };
  const contacts = await db.getProContactsForSending(accountId);
  const birthdayContacts = filterContactsWithBirthdayToday(contacts);
  if (!birthdayContacts.length) return { sent: 0 };
  const businessName = business.name || "This business";
  const replyTo = business.contact?.match(/\S+@\S+/) ? business.contact : undefined;
  let sent = 0;
  for (const c of birthdayContacts) {
    try {
      const body = personalizeBirthdayMessage(settings.messageText, settings.offerText, c.firstName);
      await sendCampaignEmail({
        to: c.email,
        subject: `${businessName} – Happy Birthday!`,
        bodyContent: body,
        businessName,
        accountId,
        replyTo
      });
      sent++;
      logger?.info?.({ accountId, email: c.email }, "Birthday email sent");
    } catch (err) {
      logger?.error?.({ err, accountId, email: c.email }, "Birthday email failed");
    }
  }
  return { sent };
}

/** Send event campaign for one business (called by scheduler when send_date is today). */
export async function sendEventCampaignForAccount(accountId, eventKey, eventYear, logger = console) {
  if (!db.useDb()) return { sent: 0 };
  const campaign = await db.getProEventCampaign(accountId, eventKey, eventYear);
  if (!campaign || campaign.status !== "confirmed" || campaign.sentAt) return { sent: 0 };
  const business = await getBusiness(accountId);
  if (!business?.isPro) return { sent: 0 };
  const contacts = await db.getProContactsForSending(accountId);
  if (!contacts.length) {
    await db.markProEventCampaignSent(accountId, eventKey, eventYear);
    return { sent: 0 };
  }
  const eventRule = EVENT_RULES.find((e) => e.key === eventKey);
  const eventName = eventRule ? eventRule.name : eventKey.replace(/_/g, " ");
  const businessName = business.name || "This business";
  const replyTo = business.contact?.match(/\S+@\S+/) ? business.contact : undefined;
  const body = (campaign.messageText || "").replace(/\{\{offer\}\}/gi, campaign.offerText || "");
  const subject = `${businessName} – ${eventName}`;
  let sent = 0;
  for (const c of contacts) {
    try {
      const personalized = body.replace(/\{\{first_name\}\}/gi, c.firstName || "there");
      await sendCampaignEmail({ to: c.email, subject, bodyContent: personalized, businessName, accountId, replyTo });
      sent++;
    } catch (err) {
      logger?.error?.({ err, accountId, email: c.email }, "Event email failed");
    }
  }
  await db.markProEventCampaignSent(accountId, eventKey, eventYear);
  logger?.info?.({ accountId, eventKey, sent }, "Event campaign sent");
  return { sent };
}

/** Send one-off campaign (called by scheduler). */
export async function sendOneOffCampaign(id, accountId, subject, body, logger = console) {
  const business = await getBusiness(accountId);
  if (!business?.isPro) return { sent: 0 };
  const contacts = await db.getProContactsForSending(accountId);
  const businessName = business.name || "This business";
  const replyTo = business.contact?.match(/\S+@\S+/) ? business.contact : undefined;
  let sent = 0;
  for (const c of contacts) {
    try {
      const personalized = (body || "").replace(/\{\{first_name\}\}/gi, c.firstName || "there");
      await sendCampaignEmail({ to: c.email, subject, bodyContent: personalized, businessName, accountId, replyTo });
      sent++;
    } catch (err) {
      logger?.error?.({ err, accountId, email: c.email }, "One-off email failed");
    }
  }
  await db.markProOneOffCampaignSent(id);
  logger?.info?.({ accountId, id, sent }, "One-off campaign sent");
  return { sent };
}
