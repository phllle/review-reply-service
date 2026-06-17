const SEND_AT_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

export function normalizeEventSendAtLocal(value) {
  return typeof value === "string" && SEND_AT_LOCAL_RE.test(value.trim())
    ? value.trim()
    : null;
}

export function isSentProEventCampaign(campaign) {
  return Boolean(campaign?.sentAt);
}

export function buildProEventCampaignUpsertData(existing, body = {}, now = new Date()) {
  const requestedStatus = hasOwn(body, "status") ? String(body.status || "").trim() : "";
  const status = requestedStatus || existing?.status || "pending";
  const sendAtLocal = hasOwn(body, "sendAtLocal")
    ? normalizeEventSendAtLocal(body.sendAtLocal)
    : existing?.sendAtLocal ?? null;

  return {
    status,
    messageText: hasOwn(body, "messageText") ? body.messageText : existing?.messageText ?? "",
    offerText: hasOwn(body, "offerText") ? body.offerText : existing?.offerText ?? "",
    sendAtLocal,
    sendEmail: hasOwn(body, "sendEmail") ? body.sendEmail : existing?.sendEmail ?? true,
    sendSms: hasOwn(body, "sendSms") ? body.sendSms : existing?.sendSms ?? true,
    confirmedAt: status === "confirmed" ? now.toISOString() : null,
    sentAt: existing?.sentAt ?? null
  };
}
