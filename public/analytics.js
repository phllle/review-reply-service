/*
 * Replyr marketing analytics (loaded only when GA_MEASUREMENT_ID is set —
 * see src/analytics.js). Three jobs:
 *
 * 1. Attribution capture (kit §7 step 2): first-touch gclid/UTMs from the
 *    landing URL into a first-party cookie + localStorage (90 days), so the
 *    server can persist them onto the business record at connect time.
 *    landing_page/UTMs are first-touch; a fresh gclid replaces an older one
 *    (the latest ad click is the one a signup belongs to).
 * 2. Consent Mode v2 banner: defaults are denied (set in the head snippet);
 *    Accept upgrades consent, Decline keeps it denied. Choice is stored in
 *    a cookie so the banner shows once.
 * 3. Connect CTA: fires the `connect_click` GA event and pre-frames the
 *    Google OAuth consent screen (kit §6) with a one-line note before
 *    redirecting — unexplained permission screens are the #1 abandonment
 *    point in this flow.
 */
(function () {
  var GA_ID = window.REPLYR_GA_ID || null;
  var ATTR_COOKIE = "replyr_attr";
  var CONSENT_COOKIE = "replyr_consent";
  var ATTR_DAYS = 90;
  var CONSENT_DAYS = 180;

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(";") : [];
    for (var i = 0; i < parts.length; i++) {
      var idx = parts[i].indexOf("=");
      if (idx === -1) continue;
      if (parts[i].slice(0, idx).trim() === name) {
        var v = parts[i].slice(idx + 1).trim();
        try { return decodeURIComponent(v); } catch (e) { return v; }
      }
    }
    return null;
  }

  function writeCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = name + "=" + encodeURIComponent(value) +
      "; Path=/; Max-Age=" + days * 24 * 60 * 60 +
      "; Expires=" + expires + "; SameSite=Lax";
  }

  // --- 1. Attribution capture ------------------------------------------------
  function loadStoredAttribution() {
    var raw = null;
    try { raw = window.localStorage.getItem(ATTR_COOKIE); } catch (e) { /* private mode */ }
    if (!raw) raw = readCookie(ATTR_COOKIE);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function storeAttribution(obj) {
    var s = JSON.stringify(obj);
    try { window.localStorage.setItem(ATTR_COOKIE, s); } catch (e) { /* ignore */ }
    writeCookie(ATTR_COOKIE, s, ATTR_DAYS);
  }

  function captureAttribution() {
    var params = new URLSearchParams(window.location.search);
    var stored = loadStoredAttribution() || {};
    var changed = false;

    var clickKeys = ["gclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
    for (var i = 0; i < clickKeys.length; i++) {
      var key = clickKeys[i];
      var v = params.get(key);
      if (!v) continue;
      v = v.slice(0, 512);
      // gclid: latest click wins. UTMs: first touch wins.
      if (key === "gclid" ? stored[key] !== v : !stored[key]) {
        stored[key] = v;
        changed = true;
      }
    }
    if (!stored.landing_page) {
      stored.landing_page = window.location.pathname;
      changed = true;
    }
    if (changed) storeAttribution(stored);

    if (GA_ID && typeof window.gtag === "function") {
      window.gtag("get", GA_ID, "client_id", function (clientId) {
        if (!clientId) return;
        var current = loadStoredAttribution() || stored;
        if (current.ga_client_id !== clientId) {
          current.ga_client_id = clientId;
          if (!current.landing_page) current.landing_page = window.location.pathname;
          storeAttribution(current);
        }
      });
    }
    return stored;
  }

  // --- 2. Consent banner -------------------------------------------------------
  function applyConsent(granted) {
    if (typeof window.gtag !== "function") return;
    var value = granted ? "granted" : "denied";
    window.gtag("consent", "update", {
      ad_storage: value,
      analytics_storage: value,
      ad_user_data: value,
      ad_personalization: value
    });
  }

  function showConsentBanner() {
    if (document.getElementById("replyr-consent")) return;
    var bar = document.createElement("div");
    bar.id = "replyr-consent";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Cookie consent");
    bar.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:300;" +
      "max-width:560px;margin:0 auto;background:#17171a;border:1px solid rgba(255,255,255,0.12);" +
      "border-radius:14px;padding:14px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;" +
      "font-family:'DM Sans',sans-serif;box-shadow:0 12px 40px rgba(0,0,0,0.45);";
    var text = document.createElement("p");
    text.textContent = "We use cookies to see how businesses find Replyr and to measure our ads. No cookies, no problem — the site works the same.";
    text.style.cssText = "flex:1 1 260px;margin:0;font-size:13px;line-height:1.5;color:#c9c7cf;";
    var accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = "Accept";
    accept.style.cssText = "background:#4a9eff;color:#0f0f11;border:none;border-radius:9px;" +
      "padding:9px 16px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;";
    var decline = document.createElement("button");
    decline.type = "button";
    decline.textContent = "Decline";
    decline.style.cssText = "background:transparent;color:#c9c7cf;border:1px solid rgba(255,255,255,0.2);" +
      "border-radius:9px;padding:9px 16px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;";
    function settle(choice) {
      writeCookie(CONSENT_COOKIE, choice, CONSENT_DAYS);
      applyConsent(choice === "granted");
      bar.remove();
    }
    accept.addEventListener("click", function () { settle("granted"); });
    decline.addEventListener("click", function () { settle("denied"); });
    bar.appendChild(text);
    bar.appendChild(accept);
    bar.appendChild(decline);
    document.body.appendChild(bar);
  }

  function initConsent() {
    var choice = readCookie(CONSENT_COOKIE);
    if (choice === "granted") {
      applyConsent(true);
    } else if (!choice) {
      showConsentBanner();
    }
  }

  // --- 3. Connect CTA: connect_click + OAuth pre-frame -------------------------
  var PREFRAME_TEXT = "Google will ask you to confirm access — that's how Replyr is allowed to post replies as you.";
  var PREFRAME_DELAY_MS = 1100;

  function showPreframeNote(anchor) {
    var note = document.createElement("p");
    note.className = "connect-note";
    note.textContent = PREFRAME_TEXT;
    note.style.cssText = "margin:12px auto 0;max-width:420px;font-size:13px;line-height:1.55;" +
      "color:#8b8a92;font-family:'DM Sans',sans-serif;text-align:center;";
    // Place the note right after the anchor's block container when there is
    // one (hero actions / CTA strip), else directly after the anchor.
    var host = anchor.parentElement || anchor;
    host.insertAdjacentElement("afterend", note);
  }

  function onConnectClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var anchor = e.target && e.target.closest ? e.target.closest('a[href="/auth/google"], [data-connect-cta]') : null;
    if (!anchor || !anchor.getAttribute("href")) return;
    if (typeof window.gtag === "function") {
      window.gtag("event", "connect_click", { page_path: window.location.pathname });
    }
    e.preventDefault();
    showPreframeNote(anchor);
    var href = anchor.href;
    window.setTimeout(function () { window.location.href = href; }, PREFRAME_DELAY_MS);
  }

  function init() {
    captureAttribution();
    initConsent();
    document.addEventListener("click", onConnectClick);
  }

  window.replyrAnalytics = {
    getAttribution: loadStoredAttribution,
    captureAttribution: captureAttribution
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
