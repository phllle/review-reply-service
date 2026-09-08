/**
 * Replyr Pro campaigns page (/pro) HTML + its client script (/pro.js).
 * Extracted verbatim from index.js — no behavior change.
 */

export function renderProPage({ accountId, birthday, escapeHtml }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Replyr Pro – Campaigns</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/review-requests.css">
<style>
  :root {
    --bg: #0f0f11;
    --surface: #17171a;
    --surface2: #1e1e22;
    --border: rgba(255,255,255,0.07);
    --accent: #4a9eff;
    --accent2: #7c6af7;
    --text: #f0ede8;
    --muted: #7a7880;
    --soft: rgba(74,158,255,0.1);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 15px; min-height: 100vh; padding: 0; }
  body::before {
    content: ''; position: fixed; top: -200px; left: 50%; transform: translateX(-50%);
    width: 800px; height: 500px;
    background: radial-gradient(ellipse, rgba(124,106,247,0.12) 0%, transparent 70%);
    pointer-events: none; z-index: 0;
  }
  .wrapper { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; position: relative; z-index: 1; }
  .page-header { margin-bottom: 48px; }
  .back-link {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--muted); text-decoration: none; font-size: 13px; font-weight: 500; letter-spacing: 0.02em;
    margin-bottom: 24px; transition: color 0.2s;
  }
  .back-link:hover { color: var(--text); }
  .back-link svg { width: 14px; height: 14px; }
  .page-title { font-family: 'Fraunces', serif; font-size: 36px; font-weight: 300; letter-spacing: -0.02em; color: var(--text); line-height: 1.1; }
  .page-title span { color: var(--accent); font-style: italic; }
  .compliance-note { margin-top: 10px; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .compliance-note a { color: var(--accent2); text-decoration: none; }
  .compliance-note a:hover { text-decoration: underline; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 20px;
    padding: 32px; margin-bottom: 20px; animation: fadeUp 0.4s ease both;
  }
  .card:nth-child(2) { animation-delay: 0.05s; }
  .card:nth-child(3) { animation-delay: 0.1s; }
  .card:nth-child(4) { animation-delay: 0.15s; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  .card-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 20px; }
  .card-icon {
    width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; font-size: 18px;
  }
  .card-icon.blue { background: rgba(74,158,255,0.15); }
  .card-icon.purple { background: rgba(124,106,247,0.15); }
  .card-icon.pink { background: rgba(255,130,130,0.12); }
  .card-title { font-family: 'Fraunces', serif; font-size: 20px; font-weight: 400; color: var(--text); line-height: 1.2; }
  .card-desc { font-size: 13px; color: var(--muted); margin-top: 4px; line-height: 1.55; }
  .toggle-row {
    display: flex; align-items: center; gap: 10px; margin-bottom: 20px;
    padding: 12px 16px; background: var(--surface2); border-radius: 12px; border: 1px solid var(--border);
  }
  .toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; cursor: pointer; }
  .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
  .toggle-track {
    position: absolute; cursor: pointer; inset: 0;
    background: #333; border-radius: 20px; transition: 0.3s;
  }
  .toggle-track::before {
    content: ''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px;
    background: #0f0f11; border-radius: 50%; transition: 0.3s; background: var(--text);
  }
  .toggle input:checked + .toggle-track { background: var(--accent); }
  .toggle input:checked + .toggle-track::before { transform: translateX(16px); background: var(--bg); }
  .toggle-label { font-size: 14px; font-weight: 500; color: var(--text); }
  .toggle-status {
    margin-left: auto; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--accent); background: var(--soft); padding: 3px 8px; border-radius: 20px;
  }
  .toggle-status.off { color: var(--muted); background: rgba(255,255,255,0.05); }
  label.field-label {
    display: block; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 8px;
  }
  textarea, input[type="text"], input[type="date"], select {
    width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 12px;
    color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 14px; padding: 14px 16px;
    resize: vertical; transition: border-color 0.2s, box-shadow 0.2s; outline: none; line-height: 1.6;
  }
  textarea:focus, input[type="text"]:focus, input[type="date"]:focus, select:focus {
    border-color: rgba(74,158,255,0.4); box-shadow: 0 0 0 3px rgba(74,158,255,0.08);
  }
  select { cursor: pointer; min-height: 46px; }
  textarea { min-height: 180px; }
  #birthday-message { min-height: 220px; }
  #event-detail-prompt { min-height: 110px; }
  #oneoff-body { min-height: 180px; }
  #oneoff-prompt { min-height: 90px; }
  .field-group { margin-bottom: 20px; }
  .field-hint { font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.5; }
  .field-input { margin-bottom: 0; }
  .btn {
    display: inline-flex; align-items: center; gap: 7px; border: none; border-radius: 10px;
    font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 600; cursor: pointer;
    padding: 11px 20px; transition: all 0.2s; letter-spacing: 0.01em;
  }
  .btn-generate {
    background: linear-gradient(135deg, rgba(124,106,247,0.18), rgba(74,158,255,0.14));
    color: var(--accent2); border: 1px solid rgba(124,106,247,0.35); margin-bottom: 20px; font-weight: 600;
  }
  .btn-generate:hover { background: linear-gradient(135deg, rgba(124,106,247,0.28), rgba(74,158,255,0.22)); color: var(--text); border-color: rgba(124,106,247,0.55); transform: translateY(-1px); box-shadow: 0 4px 16px rgba(124,106,247,0.2); }
  .btn-generate svg { width: 15px; height: 15px; }
  .btn-generate:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-primary { background: var(--accent); color: #0f0f11; }
  .btn-primary:hover { background: #6bafff; transform: translateY(-1px); box-shadow: 0 4px 20px rgba(74,158,255,0.25); }
  .btn-primary:active { transform: translateY(0); }
  .btn-primary:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }
  .btn-confirm {
    background: rgba(124,106,247,0.18); color: #a099f7; border: 1px solid rgba(124,106,247,0.25);
    font-size: 13px; padding: 8px 16px;
  }
  .btn-confirm:hover { background: rgba(124,106,247,0.28); color: #c4beff; border-color: rgba(124,106,247,0.45); }
  .btn-confirm:disabled { opacity: 0.7; cursor: default; }
  .btn-skip {
    background: transparent; color: var(--muted); border: 1px solid var(--border); font-size: 13px; padding: 8px 16px;
  }
  .btn-skip:hover { background: rgba(255,255,255,0.04); color: var(--text); }
  .btn-skip:disabled { opacity: 0.7; cursor: default; }
  .btn-confirm.event-edit { background: rgba(124,106,247,0.2); color: var(--accent2); }
  .btn-confirm.event-edit:hover { background: rgba(124,106,247,0.3); color: var(--text); }
  .btn-undo { background: transparent; color: var(--muted); border: 1px solid var(--border); font-size: 12px; padding: 6px 12px; }
  .btn-undo:hover { color: var(--accent); border-color: rgba(74,158,255,0.4); }
  .events-list { display: flex; flex-direction: column; gap: 8px; }
  .event-row {
    display: flex; align-items: center; padding: 14px 16px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 12px; transition: border-color 0.2s, background 0.2s;
  }
  .event-row:hover { border-color: rgba(255,255,255,0.12); background: rgba(255,255,255,0.03); }
  .event-emoji { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; margin-right: 12px; }
  .event-info { flex: 1; }
  .event-name { font-size: 14px; font-weight: 600; color: var(--text); }
  .event-date { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .event-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .event-detail-panel { display: none; margin-top: 16px; padding: 20px; background: var(--surface2); border: 1px solid var(--border); border-radius: 14px; }
  .event-detail-panel.visible { display: block; }
  .channel-toggles { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 12px; }
  .channel-toggles .toggle-row { margin: 0; }
  .event-detail-title { font-family: 'Fraunces', serif; font-size: 18px; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .pro-msg { margin-top: 8px; font-size: 13px; color: var(--muted); }
  .pro-msg.ok { color: #6ee7a3; }
  .pro-msg.err { color: #f87171; }
  /* Tabs across Birthday / Events / One-off — sticky at top of viewport on scroll. */
  .pro-tabs {
    position: sticky; top: 0; z-index: 10;
    display: flex; gap: 4px; padding: 8px;
    margin: 0 0 20px;
    background: rgba(15, 15, 17, 0.85); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    border: 1px solid var(--border); border-radius: 14px;
  }
  .pro-tab {
    flex: 1; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    padding: 10px 12px; border: 1px solid transparent; border-radius: 10px;
    background: transparent; color: var(--muted);
    font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 600; cursor: pointer;
    transition: background 0.18s, color 0.18s, border-color 0.18s; letter-spacing: 0.01em;
  }
  .pro-tab .pro-tab-icon { font-size: 14px; line-height: 1; }
  .pro-tab:hover { color: var(--text); background: rgba(255,255,255,0.04); }
  .pro-tab.active {
    color: var(--text);
    background: linear-gradient(135deg, rgba(124,106,247,0.18), rgba(74,158,255,0.14));
    border-color: rgba(124,106,247,0.35);
  }
  .pro-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .pro-pane { display: none; }
  .pro-pane.active { display: flex; flex-direction: column; }
  @media (max-width: 500px) { .form-row { grid-template-columns: 1fr; } }
  @media (max-width: 420px) {
    .pro-tab { padding: 9px 8px; font-size: 12px; gap: 5px; }
  }
</style>
</head>
<body>
<div class="wrapper" id="pro-app" data-account-id="${escapeHtml(accountId)}">
  <div class="page-header">
    <a href="/connected?accountId=${encodeURIComponent(accountId)}" class="back-link">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 3L5 8l5 5"/></svg>
      Back to Connected
    </a>
    <h1 class="page-title">Replyr Pro <span>Campaigns</span></h1>
    <p class="compliance-note">By uploading and sending you confirm you have permission to email and text those contacts. We send email to contacts with an address; if SMS is enabled, we also send a short text to contacts with a mobile number (birthday, events, one-off). <a href="/compliance">Compliance →</a></p>
  </div>

  <div class="pro-tabs" role="tablist" aria-label="Campaign type">
    <button type="button" class="pro-tab active" role="tab" aria-selected="true" aria-controls="tab-birthday" data-tab="birthday"><span class="pro-tab-icon">🎂</span>Birthday</button>
    <button type="button" class="pro-tab" role="tab" aria-selected="false" aria-controls="tab-events" data-tab="events"><span class="pro-tab-icon">📅</span>Events</button>
    <button type="button" class="pro-tab" role="tab" aria-selected="false" aria-controls="tab-oneoff" data-tab="oneoff"><span class="pro-tab-icon">⚡</span>One-off</button>
  </div>

  <div class="card pro-pane active" id="tab-birthday" role="tabpanel" aria-labelledby="tab-birthday-btn">
    <div class="card-header">
      <div class="card-icon blue">🎂</div>
      <div>
        <div class="card-title">Birthday messages</div>
        <div class="card-desc">One message used for all birthday messages. Use <code style="color:var(--accent);font-size:12px">{{first_name}}</code> and <code style="color:var(--accent);font-size:12px">{{offer}}</code> — filled automatically from your customer list.</div>
      </div>
    </div>
    <div class="toggle-row">
      <label class="toggle">
        <input type="checkbox" id="birthday-enabled" role="switch" aria-checked="${birthday?.enabled ? "true" : "false"}" aria-label="Enable birthday messages" ${birthday?.enabled ? "checked" : ""}>
        <span class="toggle-track"></span>
      </label>
      <span class="toggle-label">Enable birthday messages</span>
      <span class="toggle-status ${birthday?.enabled ? "" : "off"}" id="toggle-status">${birthday?.enabled ? "Active" : "Off"}</span>
    </div>
    <div class="channel-toggles">
      <div class="toggle-row">
        <label class="toggle">
          <input type="checkbox" id="birthday-send-email" role="switch" aria-checked="${(birthday?.sendEmail !== false) ? "true" : "false"}" aria-label="Send birthday email" ${(birthday?.sendEmail !== false) ? "checked" : ""}>
          <span class="toggle-track"></span>
        </label>
        <span class="toggle-label">Send email</span>
      </div>
      <div class="toggle-row">
        <label class="toggle">
          <input type="checkbox" id="birthday-send-sms" role="switch" aria-checked="${(birthday?.sendSms !== false) ? "true" : "false"}" aria-label="Send birthday SMS when contact has phone" ${(birthday?.sendSms !== false) ? "checked" : ""}>
          <span class="toggle-track"></span>
        </label>
        <span class="toggle-label">Send SMS (when contact has phone)</span>
      </div>
    </div>
    <p class="field-hint" style="margin-top:0.35rem;margin-bottom:0">SMS allows up to 160 characters for your message (plus a required "Reply STOP to opt out." footer). Messages over 137 chars send as 2 segments (~2¢ per recipient instead of ~1¢).</p>
    <div class="field-group">
      <label class="field-label">Describe your business (optional)</label>
      <input type="text" id="birthday-prompt" placeholder="e.g. Anchovie and Salts is a seafood restaurant in Seattle — tailor the message to that" class="field-input">
      <p class="field-hint">Add a short description so Replyr can tailor the birthday message to your business name and type.</p>
    </div>
    <div class="field-group">
      <label class="field-label">Message</label>
      <textarea id="birthday-message" placeholder="Happy birthday, {{first_name}}! As a thank you, {{offer}}...">${escapeHtml(birthday?.messageText || "")}</textarea>
      <div id="birthday-message-counter" class="sms-counter" style="font-size:12px;margin-top:4px;color:var(--muted)">0 chars · 1 SMS segment</div>
    </div>
    <button type="button" class="btn btn-generate" id="birthday-generate">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13 2L3 6l4 3 3 4 3-11z"/></svg>
      Generate with Replyr
    </button>
    <div class="field-group">
      <label class="field-label">Offer</label>
      <input type="text" id="birthday-offer" value="${escapeHtml(birthday?.offerText || "")}" placeholder="e.g. 20% off next visit">
    </div>
    <button type="button" class="btn btn-primary" id="birthday-save">Save changes</button>
    <span id="birthday-msg" class="pro-msg" aria-live="polite"></span>
  </div>

  <div class="card pro-pane" id="tab-events" role="tabpanel">
    <div class="card-header">
      <div class="card-icon purple">📅</div>
      <div>
        <div class="card-title">Upcoming events</div>
        <div class="card-desc">Opt in per event. We show the <strong style="color:var(--text)">event date</strong> (the holiday); you choose the <strong style="color:var(--text)">exact send date and time</strong> in Pacific Time. Set message and offer, then Confirm.</div>
      </div>
    </div>
    <div class="events-list" id="events-list"></div>
    <div class="event-detail-panel" id="event-detail-panel">
      <div class="event-detail-title" id="event-detail-title">Event</div>
      <div class="field-group">
        <label class="field-label">Prompt for Replyr (optional)</label>
        <textarea id="event-detail-prompt" placeholder="e.g. Keep it warm and short, mention we're a nail salon, highlight spring colors"></textarea>
        <p class="field-hint">Used only when you click <strong>Generate with Replyr</strong>. Add tone, style, and business context.</p>
      </div>
      <div class="field-group">
        <label class="field-label">Message</label>
        <textarea id="event-detail-message" placeholder="e.g. Happy Easter! {{first_name}}, {{offer}}... Use {{first_name}} and {{offer}}." style="min-height: 160px;"></textarea>
        <div id="event-detail-message-counter" class="sms-counter" style="font-size:12px;margin-top:4px;color:var(--muted)">0 chars · 1 SMS segment</div>
      </div>
      <button type="button" class="btn btn-generate" id="event-detail-generate">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13 2L3 6l4 3 3 4 3-11z"/></svg>
        Generate with Replyr
      </button>
      <div class="field-group">
        <label class="field-label">Offer</label>
        <input type="text" id="event-detail-offer" placeholder="e.g. 20% off next visit">
      </div>
      <div class="field-group">
        <label class="field-label">When to send (Pacific Time - PST/PDT)</label>
        <input type="datetime-local" id="event-detail-send-at" class="field-input">
        <p class="field-hint">Pick the exact date and time in Pacific Time.</p>
        <p id="event-detail-send-at-tz" class="field-hint" style="margin-top:4px;display:none"></p>
      </div>
      <div class="channel-toggles">
        <div class="toggle-row">
          <label class="toggle">
            <input type="checkbox" id="event-detail-send-email" role="switch" aria-checked="true" aria-label="Send event email" checked>
            <span class="toggle-track"></span>
          </label>
          <span class="toggle-label">Send email</span>
        </div>
        <div class="toggle-row">
          <label class="toggle">
            <input type="checkbox" id="event-detail-send-sms" role="switch" aria-checked="true" aria-label="Send event SMS when contact has phone" checked>
            <span class="toggle-track"></span>
          </label>
          <span class="toggle-label">Send SMS (when contact has phone)</span>
        </div>
      </div>
      <p class="field-hint" style="margin-top:0.35rem;margin-bottom:0">SMS allows up to 160 characters for your message (plus a required "Reply STOP to opt out." footer). Messages over 137 chars send as 2 segments (~2¢ per recipient instead of ~1¢).</p>
      <button type="button" class="btn btn-primary" id="event-detail-save">Save and confirm</button>
      <span id="event-detail-msg" class="pro-msg" aria-live="polite"></span>
    </div>
  </div>

  <div class="card pro-pane" id="tab-oneoff" role="tabpanel">
    <div class="card-header">
      <div class="card-icon pink">⚡</div>
      <div>
        <div class="card-title">One-off promo</div>
        <div class="card-desc">Schedule a single campaign for any date. Use <code style="color:var(--accent);font-size:12px">{{first_name}}</code> in the body — filled automatically from your customer list.</div>
      </div>
    </div>
    <div class="field-group">
      <label class="field-label">Describe your promo</label>
      <textarea id="oneoff-prompt" placeholder="e.g. Mother's Day 20% off manicures, or Summer sale – free nail art with any service"></textarea>
    </div>
    <button type="button" class="btn btn-generate" id="oneoff-generate">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13 2L3 6l4 3 3 4 3-11z"/></svg>
      Generate with Replyr
    </button>
    <div class="form-row">
      <div class="field-group" style="margin-bottom:0">
        <label class="field-label">Send date</label>
        <input type="date" id="oneoff-date">
      </div>
      <div class="field-group" style="margin-bottom:0">
        <label class="field-label">Subject line</label>
        <input type="text" id="oneoff-subject" placeholder="Subject line">
      </div>
    </div>
    <div class="field-group">
      <label class="field-label">Body</label>
      <textarea id="oneoff-body" placeholder="Email body..."></textarea>
      <div id="oneoff-body-counter" class="sms-counter" style="font-size:12px;margin-top:4px;color:var(--muted)">0 chars · 1 SMS segment</div>
    </div>
    <div class="channel-toggles">
      <div class="toggle-row">
        <label class="toggle">
          <input type="checkbox" id="oneoff-send-email" role="switch" aria-checked="true" aria-label="Send one-off promo email" checked>
          <span class="toggle-track"></span>
        </label>
        <span class="toggle-label">Send email</span>
      </div>
      <div class="toggle-row">
        <label class="toggle">
          <input type="checkbox" id="oneoff-send-sms" role="switch" aria-checked="true" aria-label="Send one-off promo SMS when contact has phone" checked>
          <span class="toggle-track"></span>
        </label>
        <span class="toggle-label">Send SMS (when contact has phone)</span>
      </div>
    </div>
    <p class="field-hint" style="margin-top:0.35rem;margin-bottom:0">SMS allows up to 160 characters for your message (plus a required "Reply STOP to opt out." footer). Messages over 137 chars send as 2 segments (~2¢ per recipient instead of ~1¢).</p>
    <button type="button" class="btn btn-primary" id="oneoff-schedule">Schedule campaign</button>
    <span id="oneoff-msg" class="pro-msg" aria-live="polite"></span>
  </div>
</div>
<script src="/pro.js"></script>
<script src="/review-requests.js"></script>
</body>
</html>`;
}

export function proScript() {
  return `
(function() {
  // Keep aria-checked in sync with any role="switch" checkbox.
  document.addEventListener("change", function(e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute("role") === "switch") {
      t.setAttribute("aria-checked", t.checked ? "true" : "false");
    }
  });

  var app = document.getElementById("pro-app");
  if (!app) return;
  var accountId = (app.getAttribute("data-account-id") || "").trim();
  if (!accountId) return;

  // Tabs — show one campaign type pane at a time, keep selection in URL hash
  // so links like /pro#events deep-link straight to a section.
  (function() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".pro-tab"));
    var panes = Array.prototype.slice.call(document.querySelectorAll(".pro-pane"));
    if (!tabs.length || !panes.length) return;
    function show(name) {
      tabs.forEach(function(t) {
        var match = t.getAttribute("data-tab") === name;
        t.classList.toggle("active", match);
        t.setAttribute("aria-selected", match ? "true" : "false");
        t.setAttribute("tabindex", match ? "0" : "-1");
      });
      panes.forEach(function(p) {
        p.classList.toggle("active", p.id === "tab-" + name);
      });
    }
    var initial = (window.location.hash || "").replace(/^#/, "");
    if (!initial || !document.getElementById("tab-" + initial)) initial = "birthday";
    show(initial);
    tabs.forEach(function(t, i) {
      t.addEventListener("click", function() {
        var name = t.getAttribute("data-tab");
        show(name);
        if (history && history.replaceState) history.replaceState(null, "", "#" + name);
      });
      // Left/Right arrows move between tabs.
      t.addEventListener("keydown", function(e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        var next = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
        tabs[next].focus();
        tabs[next].click();
      });
    });
  })();

  // Show the user their local equivalent of the chosen Pacific-Time send time
  // when they're not actually in PT. Florida shop owners should not have to do
  // mental math on every event.
  (function() {
    var sendAtEl = document.getElementById("event-detail-send-at");
    var tzHint = document.getElementById("event-detail-send-at-tz");
    if (!sendAtEl || !tzHint) return;
    var localTz = "";
    try { localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {}
    if (!localTz || localTz === "America/Los_Angeles") return;

    function ptToUtcMs(localStr) {
      // Input: "YYYY-MM-DDTHH:MM" interpreted as Pacific Time (handles PST/PDT
      // automatically via Intl.DateTimeFormat). Output: UTC ms.
      var m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})$/.exec(localStr);
      if (!m) return null;
      var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
      // Get PT offset for this wall-clock time. We approximate: build a UTC
      // date with the wall-clock numbers, then ask Intl what time those UTC
      // ms render as in LA, and shift by the difference.
      var asUtc = Date.UTC(y, mo - 1, d, h, mi);
      var dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
      });
      var parts = dtf.formatToParts(new Date(asUtc));
      function p(t) { var x = parts.find(function(q) { return q.type === t; }); return x ? +x.value : 0; }
      var laUtc = Date.UTC(p("year"), p("month") - 1, p("day"), p("hour") % 24, p("minute"));
      // diff = how many ms ahead UTC reads vs LA wall-clock at this instant.
      var offsetMs = asUtc - laUtc;
      // Wall-clock-in-LA = asUtc - offsetMs, so the actual UTC moment = asUtc + offsetMs.
      return asUtc + offsetMs;
    }
    function render() {
      var v = sendAtEl.value;
      var utc = ptToUtcMs(v);
      if (utc == null) { tzHint.style.display = "none"; tzHint.textContent = ""; return; }
      var fmt = new Intl.DateTimeFormat(undefined, {
        timeZone: localTz, weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short"
      });
      tzHint.textContent = "In your timezone (" + localTz + "): " + fmt.format(new Date(utc));
      tzHint.style.display = "";
    }
    sendAtEl.addEventListener("input", render);
    sendAtEl.addEventListener("change", render);
    // Render now in case a value was already populated by event-detail load.
    render();
    // Also re-render when the panel becomes visible / a new event is loaded.
    var panel = document.getElementById("event-detail-panel");
    if (panel && typeof MutationObserver !== "undefined") {
      new MutationObserver(render).observe(panel, { attributes: true, attributeFilter: ["class"] });
    }
  })();

  var eventEmoji = { valentines_day: "❤️", presidents_day: "🎩", lunar_new_year: "🧧", easter: "🐣", mothers_day: "🌷", memorial_day: "🎖️", fathers_day: "👔", independence_day: "🇺🇸", labor_day: "📋", halloween: "🎃", thanksgiving: "🦃", black_friday: "🛒", christmas: "🎄", new_year: "⭐" };
  function loadEvents() {
    fetch("/pro/events", { credentials: "same-origin" }).then(function(r) { return r.json(); }).then(function(events) {
      var el = document.getElementById("events-list");
      if (!el) return;
      function fmtDate(iso) {
        try {
          var d = new Date(iso + "T12:00:00");
          return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        } catch (_) { return iso; }
      }
      function defaultSendAtLocal(eventDateIso) {
        if (!eventDateIso || !/^\\d{4}-\\d{2}-\\d{2}$/.test(eventDateIso)) return "";
        // Default to 10:00 local Pacific time on the event date.
        return eventDateIso + "T10:00";
      }
      el.innerHTML = events.slice(0, 14).map(function(ev) {
        var eventDateStr = fmtDate(ev.sendDate);
        var emoji = eventEmoji[ev.key] || "📅";
        var y = ev.sendDate.slice(0, 4);
        return '<div class="event-row" data-key="' + ev.key + '" data-year="' + y + '">' +
          '<div class="event-emoji">' + emoji + '</div>' +
          '<div class="event-info"><div class="event-name">' + ev.name + '</div><div class="event-date">' + eventDateStr + '</div></div>' +
          '<div class="event-actions">' +
          '<button type="button" class="btn btn-confirm event-confirm" data-key="' + ev.key + '" data-year="' + y + '" data-name="' + (ev.name || "").replace(/"/g, "&quot;") + '" data-date="' + eventDateStr.replace(/"/g, "&quot;") + '" data-event-date="' + (ev.sendDate || "") + '">Confirm</button>' +
          '<button type="button" class="btn btn-skip event-skip" data-key="' + ev.key + '" data-year="' + y + '">Skip</button>' +
          '<button type="button" class="btn btn-undo event-undo" data-key="' + ev.key + '" data-year="' + y + '" style="display:none">Undo</button>' +
          '</div></div>';
      }).join("");
      var panel = document.getElementById("event-detail-panel");
      var panelTitle = document.getElementById("event-detail-title");
      var panelMessage = document.getElementById("event-detail-message");
      var panelOffer = document.getElementById("event-detail-offer");
      var panelSendAt = document.getElementById("event-detail-send-at");
      var panelPrompt = document.getElementById("event-detail-prompt");
      var panelMsg = document.getElementById("event-detail-msg");
      el.querySelectorAll(".event-confirm").forEach(function(btn) {
        btn.onclick = function() {
          if (btn.disabled) return;
          var key = btn.getAttribute("data-key");
          var year = btn.getAttribute("data-year");
          var name = btn.getAttribute("data-name") || key.replace(/_/g, " ");
          var dateStr = btn.getAttribute("data-date") || "";
          var eventDateIso = btn.getAttribute("data-event-date") || "";
          panel.dataset.key = key;
          panel.dataset.year = year;
          panel.dataset.eventName = name;
          panel._confirmBtn = btn;
          panelTitle.textContent = name + (dateStr ? " – " + dateStr : "");
          panelMessage.value = "";
          panelMessage.dispatchEvent(new Event("input"));
          panelOffer.value = "";
          if (panelSendAt) panelSendAt.value = defaultSendAtLocal(eventDateIso);
          panelPrompt.value = "";
          panelMsg.textContent = "";
          panel.classList.add("visible");
          var sendEmailEl = document.getElementById("event-detail-send-email");
          var sendSmsEl = document.getElementById("event-detail-send-sms");
          function syncAria(el) { if (el && el.getAttribute("role") === "switch") el.setAttribute("aria-checked", el.checked ? "true" : "false"); }
          if (sendEmailEl) { sendEmailEl.checked = true; syncAria(sendEmailEl); }
          if (sendSmsEl) { sendSmsEl.checked = true; syncAria(sendSmsEl); }
          fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), { credentials: "same-origin" })
            .then(function(r) { return r.json(); })
            .then(function(c) {
              if (c && c.messageText) { panelMessage.value = c.messageText; panelMessage.dispatchEvent(new Event("input")); }
              if (c && c.offerText) panelOffer.value = c.offerText;
              if (panelSendAt && c && c.sendAtLocal) panelSendAt.value = c.sendAtLocal;
              if (sendEmailEl && c && c.sendEmail !== undefined) { sendEmailEl.checked = c.sendEmail !== false; syncAria(sendEmailEl); }
              if (sendSmsEl && c && c.sendSms !== undefined) { sendSmsEl.checked = c.sendSms !== false; syncAria(sendSmsEl); }
              if (c && c.status === "confirmed") { btn.textContent = "Edit"; btn.classList.add("event-edit"); }
            })
            .catch(function() {});
        };
      });
      el.querySelectorAll(".event-skip").forEach(function(btn) {
        btn.onclick = function() {
          if (btn.disabled) return;
          var row = btn.closest(".event-row");
          var undoBtn = row ? row.querySelector(".event-undo") : null;
          var key = btn.getAttribute("data-key");
          var year = btn.getAttribute("data-year");
          fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: accountId, status: "skipped" })
          }).then(function(r) { return r.json(); }).then(function() {
            btn.textContent = "Skipped";
            btn.disabled = true;
            if (undoBtn) undoBtn.style.display = "";
          });
        };
      });
      el.querySelectorAll(".event-undo").forEach(function(btn) {
        btn.onclick = function() {
          var row = btn.closest(".event-row");
          var skipBtn = row ? row.querySelector(".event-skip") : null;
          var key = btn.getAttribute("data-key");
          var year = btn.getAttribute("data-year");
          fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: accountId, status: "pending" })
          }).then(function(r) { return r.json(); }).then(function() {
            if (skipBtn) { skipBtn.textContent = "Skip"; skipBtn.disabled = false; }
            btn.style.display = "none";
          }).catch(function() { alert("Undo failed"); });
        };
      });
      function applyEventRowStatusFromCampaign(row, c) {
        if (!row || !c || c.error) return;
        var confirmBtn = row.querySelector(".event-confirm");
        var skipBtn = row.querySelector(".event-skip");
        var undoBtn = row.querySelector(".event-undo");
        if (!confirmBtn) return;
        if (c.sentAt) {
          confirmBtn.textContent = "Sent";
          confirmBtn.disabled = true;
          confirmBtn.classList.remove("event-edit");
          if (skipBtn) skipBtn.style.display = "none";
          return;
        }
        if (c.status === "confirmed") {
          confirmBtn.textContent = "Edit";
          confirmBtn.classList.add("event-edit");
          confirmBtn.disabled = false;
        }
        if (c.status === "skipped") {
          if (skipBtn) { skipBtn.textContent = "Skipped"; skipBtn.disabled = true; }
          if (undoBtn) undoBtn.style.display = "";
        }
      }
      el.querySelectorAll(".event-row").forEach(function(row) {
        var confirmBtn = row.querySelector(".event-confirm");
        if (!confirmBtn) return;
        var key = confirmBtn.getAttribute("data-key");
        var year = confirmBtn.getAttribute("data-year");
        fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), { credentials: "same-origin" })
          .then(function(r) { return r.json().then(function(c) { return { ok: r.ok, c: c }; }); })
          .then(function(x) {
            if (!x.ok) return;
            applyEventRowStatusFromCampaign(row, x.c);
          })
          .catch(function() {});
      });
    });
  }
  loadEvents();

  var eventDetailPanel = document.getElementById("event-detail-panel");
  var eventDetailGenerate = document.getElementById("event-detail-generate");
  var eventDetailSave = document.getElementById("event-detail-save");
  if (eventDetailGenerate) {
    var eventDetailGenerateOrig = eventDetailGenerate.innerHTML;
    eventDetailGenerate.onclick = function() {
      if (!eventDetailPanel || !eventDetailPanel.dataset.key) return;
      var eventName = eventDetailPanel.dataset.eventName || "";
      var offerText = (document.getElementById("event-detail-offer") && document.getElementById("event-detail-offer").value) ? document.getElementById("event-detail-offer").value.trim() : "";
      var businessPrompt = (document.getElementById("event-detail-prompt") && document.getElementById("event-detail-prompt").value) ? document.getElementById("event-detail-prompt").value.trim() : "";
      eventDetailGenerate.disabled = true;
      eventDetailGenerate.innerHTML = eventDetailGenerateOrig.replace(/Generate with Replyr/g, "Thinking…");
      fetch("/pro/generate-message", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, type: "event", eventName: eventName, offerText: offerText, prompt: businessPrompt })
      }).then(function(r) { return r.json(); }).then(function(data) {
        var ta = document.getElementById("event-detail-message");
        if (ta && data.messageText) { ta.value = data.messageText; ta.dispatchEvent(new Event("input")); }
      }).catch(function() { alert("Generate failed"); }).finally(function() {
        eventDetailGenerate.innerHTML = eventDetailGenerateOrig;
        eventDetailGenerate.disabled = false;
      });
    };
  }
  if (eventDetailSave) {
    eventDetailSave.onclick = function() {
      if (!eventDetailPanel || !eventDetailPanel.dataset.key) return;
      var key = eventDetailPanel.dataset.key;
      var year = eventDetailPanel.dataset.year;
      var message = document.getElementById("event-detail-message") ? document.getElementById("event-detail-message").value : "";
      var offer = document.getElementById("event-detail-offer") ? document.getElementById("event-detail-offer").value : "";
      var sendAtEl = document.getElementById("event-detail-send-at");
      var sendAtLocal = sendAtEl ? String(sendAtEl.value || "").trim() : "";
      var sendEmailEl = document.getElementById("event-detail-send-email");
      var sendSmsEl = document.getElementById("event-detail-send-sms");
      var sendEmail = sendEmailEl ? sendEmailEl.checked : true;
      var sendSms = sendSmsEl ? sendSmsEl.checked : true;
      var msgEl = document.getElementById("event-detail-msg");
      eventDetailSave.disabled = true;
      if (msgEl) msgEl.textContent = "";
      fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, status: "confirmed", messageText: message, offerText: offer, sendAtLocal: sendAtLocal, sendEmail: sendEmail, sendSms: sendSms })
      }).then(function(r) {
        return r.json().catch(function() { return {}; }).then(function(data) { return { ok: r.ok, data: data }; });
      }).then(function(x) {
        if (!x.ok) {
          throw new Error((x.data && x.data.error) || "Save failed.");
        }
        if (msgEl) { msgEl.textContent = "Saved and confirmed."; msgEl.className = "pro-msg ok"; }
        eventDetailPanel.classList.remove("visible");
        if (eventDetailPanel._confirmBtn) {
          eventDetailPanel._confirmBtn.textContent = "Edit";
          eventDetailPanel._confirmBtn.disabled = false;
          eventDetailPanel._confirmBtn.classList.add("event-edit");
        }
      }).catch(function(err) {
        if (msgEl) { msgEl.textContent = (err && err.message) ? err.message : "Save failed."; msgEl.className = "pro-msg err"; }
      }).finally(function() { eventDetailSave.disabled = false; });
    };
  }

  var birthdayCheck = document.getElementById("birthday-enabled");
  var toggleStatus = document.getElementById("toggle-status");
  if (birthdayCheck && toggleStatus) {
    birthdayCheck.addEventListener("change", function() { toggleStatus.textContent = birthdayCheck.checked ? "Active" : "Off"; toggleStatus.classList.toggle("off", !birthdayCheck.checked); });
  }

  var birthdayGenerate = document.getElementById("birthday-generate");
  if (birthdayGenerate) {
    var birthdayGenerateOrig = birthdayGenerate.innerHTML;
    birthdayGenerate.onclick = function() {
      var offerInput = document.getElementById("birthday-offer");
      var promptInput = document.getElementById("birthday-prompt");
      var offerText = (offerInput && offerInput.value) ? offerInput.value.trim() : "";
      var businessPrompt = (promptInput && promptInput.value) ? promptInput.value.trim() : "";
      birthdayGenerate.disabled = true;
      birthdayGenerate.innerHTML = birthdayGenerateOrig.replace(/Generate with Replyr/g, "Thinking…");
      fetch("/pro/generate-message", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, type: "birthday", offerText: offerText, prompt: businessPrompt })
      }).then(function(r) { return r.json(); }).then(function(data) {
        var ta = document.getElementById("birthday-message");
        if (ta && data.messageText) { ta.value = data.messageText; ta.dispatchEvent(new Event("input")); }
      }).catch(function() { alert("Generate failed"); }).finally(function() {
        birthdayGenerate.innerHTML = birthdayGenerateOrig;
        birthdayGenerate.disabled = false;
      });
    };
  }
  var birthdaySave = document.getElementById("birthday-save");
  if (birthdaySave) {
    birthdaySave.onclick = function() {
      var enabled = document.getElementById("birthday-enabled").checked;
      var message = document.getElementById("birthday-message").value;
      var offer = document.getElementById("birthday-offer").value;
      var sendEmailEl = document.getElementById("birthday-send-email");
      var sendSmsEl = document.getElementById("birthday-send-sms");
      var sendEmail = sendEmailEl ? sendEmailEl.checked : true;
      var sendSms = sendSmsEl ? sendSmsEl.checked : true;
      birthdaySave.disabled = true;
      fetch("/pro/birthday-settings", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, enabled: enabled, messageText: message, offerText: offer, sendEmail: sendEmail, sendSms: sendSms })
      }).then(function(r) { return r.json(); }).then(function() {
        var m = document.getElementById("birthday-msg"); m.textContent = "Saved."; m.className = "pro-msg ok";
      }).catch(function() {
        var m = document.getElementById("birthday-msg"); m.textContent = "Save failed."; m.className = "pro-msg err";
      }).finally(function() { birthdaySave.disabled = false; });
    };
  }

  var oneoffGenerate = document.getElementById("oneoff-generate");
  if (oneoffGenerate) {
    var oneoffGenerateOrig = oneoffGenerate.innerHTML;
    oneoffGenerate.onclick = function() {
      var promptEl = document.getElementById("oneoff-prompt");
      var promptText = (promptEl && promptEl.value) ? promptEl.value.trim() : "";
      if (!promptText) { alert("Describe your promo first (e.g. Mother's Day 20% off)."); return; }
      oneoffGenerate.disabled = true;
      oneoffGenerate.innerHTML = oneoffGenerateOrig.replace(/Generate with Replyr/g, "Thinking…");
      fetch("/pro/generate-message", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, type: "one_off", prompt: promptText })
      }).then(function(r) { return r.json(); }).then(function(data) {
        var sub = document.getElementById("oneoff-subject");
        var bod = document.getElementById("oneoff-body");
        if (sub && data.subject) sub.value = data.subject;
        if (bod && data.body) { bod.value = data.body; bod.dispatchEvent(new Event("input")); }
      }).catch(function() { alert("Generate failed."); }).finally(function() {
        oneoffGenerate.innerHTML = oneoffGenerateOrig;
        oneoffGenerate.disabled = false;
      });
    };
  }
  var oneoffSchedule = document.getElementById("oneoff-schedule");
  if (oneoffSchedule) {
    oneoffSchedule.onclick = function() {
      var date = document.getElementById("oneoff-date").value;
      var subject = document.getElementById("oneoff-subject").value.trim();
      var body = document.getElementById("oneoff-body").value;
      if (!date || !subject) { alert("Date and subject required"); return; }
      var sendEmailEl = document.getElementById("oneoff-send-email");
      var sendSmsEl = document.getElementById("oneoff-send-sms");
      var sendEmail = sendEmailEl ? sendEmailEl.checked : true;
      var sendSms = sendSmsEl ? sendSmsEl.checked : true;
      oneoffSchedule.disabled = true;
      fetch("/pro/one-off", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, sendDate: date, subject: subject, body: body, sendEmail: sendEmail, sendSms: sendSms })
      }).then(function(r) { return r.json(); }).then(function() {
        var m = document.getElementById("oneoff-msg"); m.textContent = "Scheduled for " + date + "."; m.className = "pro-msg ok";
        document.getElementById("oneoff-date").value = "";
        document.getElementById("oneoff-subject").value = "";
        document.getElementById("oneoff-body").value = "";
      }).catch(function() {
        var m = document.getElementById("oneoff-msg"); m.textContent = "Failed."; m.className = "pro-msg err";
      }).finally(function() { oneoffSchedule.disabled = false; });
    };
  }

  // SMS body budget: 160 chars + 23-char STOP footer = 183 total (2 GSM segments)
  (function() {
    var SMS_SOFT_WARN = 130;
    var SMS_HARD_CAP = 160;

    function smsSegments(text) {
      var total = text.length + 23; // include STOP footer in segment count
      if (total <= 160) return { chars: text.length, segs: 1 };
      return { chars: text.length, segs: Math.ceil(total / 153) };
    }

    function updateCounter(taId, counterId) {
      var ta = document.getElementById(taId);
      var counter = document.getElementById(counterId);
      if (!ta || !counter) return;

      function refresh() {
        var text = ta.value;
        if (text.length > SMS_HARD_CAP) {
          ta.value = text.slice(0, SMS_HARD_CAP);
          text = ta.value;
        }
        var s = smsSegments(text);
        counter.textContent = s.chars + " / " + SMS_HARD_CAP + " chars · " + s.segs + " SMS segment" + (s.segs === 1 ? "" : "s") + " (~" + s.segs + "¢ per recipient)";
        if (s.chars > SMS_SOFT_WARN) {
          counter.style.color = "#e67e22";
        } else {
          counter.style.color = "var(--muted)";
        }
      }
      ta.addEventListener("input", refresh);
      ta.addEventListener("change", refresh);
      refresh();
    }

    updateCounter("birthday-message", "birthday-message-counter");
    updateCounter("event-detail-message", "event-detail-message-counter");
    updateCounter("oneoff-body", "oneoff-body-counter");
  })();

})();
`;
}
