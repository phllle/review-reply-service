/**
 * Admin views (/admin, /admin.js, /admin/metrics, admin sign-in) HTML + client
 * script. Extracted verbatim from index.js — no behavior change. Auth checks stay
 * in the route handlers; these functions render markup only.
 */

import { escapeHtml, darkShellHtml, adminBaseCss, adminNavHtml } from "./shell.js";
import { formatCentsAsUsd } from "../metrics.js";

// Admin sign-in page (POST-only secret; sets an HttpOnly cookie). Renders on any
// unauthorized admin HTML route. The secret never appears in a URL or in JS.
export function renderAdminLoginHtml(message = "") {
  return darkShellHtml({
    title: "Replyr – Admin sign in",
    narrow: true,
    bodyHtml: `    <h1>Admin <em>sign in</em></h1>
    <p>Enter your admin secret. It's sent once over POST and stored in a short-lived, HttpOnly cookie — never in the URL.</p>
    ${message ? `<p style="color:var(--danger,#ff6b6b)">${escapeHtml(message)}</p>` : ""}
    <form method="post" action="/admin/login" style="margin-top:8px">
      <input type="password" name="secret" placeholder="Admin secret" autocomplete="off" aria-label="Admin secret" style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:12px;color:var(--text);font:inherit;padding:12px 14px;margin-bottom:12px">
      <button type="submit" class="doc-btn">Sign in</button>
    </form>`
  });
}

// Admin "disabled" page shown when ADMIN_SECRET is unset.
export function renderAdminDisabledHtml() {
  return darkShellHtml({
    title: "Replyr – Admin disabled",
    bodyHtml: `    <h1>Admin <em>disabled</em></h1>
    <p>Set <code>ADMIN_SECRET</code> in the server environment to enable admin pages.</p>`,
    narrow: true
  });
}

// Admin businesses page (/admin). Static markup; data is fetched by /admin.js.
export function renderAdminPage() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Replyr – Admin</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>${adminBaseCss()}</style>
  <style>
    /* Businesses table — dense, scrolls horizontally if needed */
    .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; overflow: auto; animation: fadeUp 0.4s ease both; }
    table { width: 100%; border-collapse: collapse; min-width: 880px; }
    thead th {
      position: sticky; top: 0; z-index: 1;
      background: var(--surface2); color: var(--muted); font-size: 11px; font-weight: 600;
      letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
      padding: 12px 14px; border-bottom: 1px solid var(--border);
    }
    tbody td { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: rgba(255,255,255,0.02); }
    input[type="text"], input[type="number"], select {
      background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;
      color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 13px; padding: 7px 10px;
      transition: border-color 0.18s, box-shadow 0.18s; outline: none; min-width: 0;
    }
    input[type="text"] { width: 100%; }
    input[type="number"] { width: 70px; }
    select { cursor: pointer; }
    input:focus, select:focus { border-color: rgba(74,158,255,0.5); box-shadow: 0 0 0 3px rgba(74,158,255,0.1); }
    input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
    button {
      background: var(--accent); color: #0f0f11; border: none; border-radius: 8px;
      font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 600; cursor: pointer;
      padding: 7px 12px; transition: all 0.18s;
    }
    button:hover:not(:disabled) { background: #6bafff; transform: translateY(-1px); }
    button:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    button[data-run-now] { background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }
    button[data-run-now]:hover:not(:disabled) { background: rgba(124,106,247,0.15); color: var(--text); border-color: rgba(124,106,247,0.4); }
    [data-pro-link] { font-size: 12px; color: var(--accent2); text-decoration: none; padding: 6px 10px; border-radius: 8px; transition: background 0.18s; }
    [data-pro-link]:hover { background: rgba(124,106,247,0.12); color: #a099f7; text-decoration: none; }
    .actions-cell { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .msg { display: block; margin-top: 4px; font-size: 11px; min-height: 1em; }
    .msg.ok { color: #6ee7a3; }
    .msg.err { color: var(--danger); }
    .empty {
      background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
      padding: 48px 24px; text-align: center; color: var(--muted); font-size: 14px;
    }
    .filter-row {
      display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 14px;
    }
    .filter-row label { font-size: 12px; color: var(--muted); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    .status-subscribed, .status-trial, .status-expired, .status-gratis, .status-pro {
      display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
      letter-spacing: 0.04em; text-transform: uppercase;
    }
    .status-subscribed { background: rgba(110,231,163,0.15); color: #6ee7a3; }
    .status-trial { background: rgba(74,158,255,0.15); color: var(--accent); }
    .status-expired { background: rgba(255,107,107,0.15); color: var(--danger); }
    .status-gratis { background: rgba(110,231,163,0.15); color: #6ee7a3; }
    .status-pro { background: rgba(124,106,247,0.18); color: #a099f7; }
    .loading { color: var(--muted); padding: 32px 4px; text-align: center; font-size: 14px; }
  </style>
</head>
<body>
  <div class="admin-wrap">
    ${adminNavHtml("businesses")}
    <div class="admin-page">
      <div class="admin-header">
        <h1>Businesses</h1>
        <p class="admin-subtitle">Edit contact, Pro tier, and auto-reply settings per business. Click <strong>Run now</strong> to trigger Claude auto-reply for that business immediately.</p>
        <p class="admin-tools"><a href="/admin" id="admin-refresh-link">Refresh</a> · <a href="/businesses" id="admin-json-link">JSON export</a></p>
      </div>
      <div id="loading" class="loading">Loading businesses…</div>
      <div id="content" style="display: none;">
        <div class="filter-row" id="filter-row" style="display: none;"><label for="status-filter">Status</label><select id="status-filter"><option value="">All</option><option value="trial">Trial</option><option value="subscribed">Subscribed</option><option value="pro">Pro</option><option value="gratis">Complimentary</option><option value="expired">Expired</option></select></div>
      </div>
    </div>
  </div>
  <script src="/admin.js"></script>
</body>
</html>
  `;
}

// Admin client script (/admin.js). Served separately so CSP allows it. Auth rides
// on the HttpOnly admin cookie via credentials:"same-origin".
export function adminScript(adminShowProScaleTier) {
  return `
var REPLYR_ADMIN_SHOW_PRO_SCALE = ${JSON.stringify(adminShowProScaleTier)};
function replyrAdminHeaders(json) {
  var h = {};
  if (json) h["Content-Type"] = "application/json";
  return h;
}
(function initAdminLinks() {
  var j = document.getElementById("admin-json-link");
  if (j) {
    j.href = "#";
    j.addEventListener("click", function(e) {
      e.preventDefault();
      fetch("/businesses", { headers: replyrAdminHeaders(false), credentials: "same-origin" })
        .then(function(r2) { return r2.json(); })
        .then(function(data) {
          var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          var u = URL.createObjectURL(blob);
          window.open(u, "_blank");
          setTimeout(function() { URL.revokeObjectURL(u); }, 60000);
        })
        .catch(function() { alert("Failed to load JSON"); });
    });
  }
})();
function proTierSelectInnerHtml(tier) {
  var o = '<option value="starter"' + (tier === "starter" ? " selected" : "") + '>Starter — 500 SMS/mo</option>' +
    '<option value="growth"' + (tier === "growth" ? " selected" : "") + '>Growth — 1,500 SMS/mo</option>' +
    '<option value="scale"' + (tier === "scale" ? " selected" : "") + '>Scale — 10,000 SMS/mo</option>';
  return o;
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
function getStatus(b) {
  if (b.subscribedAt) return { status: "subscribed", label: "Subscribed", className: "status-subscribed" };
  if (b.gratisAccess) return { status: "gratis", label: "Complimentary", className: "status-gratis" };
  if (b.isPro) return { status: "pro", label: "Pro", className: "status-pro" };
  if (b.trialEndsAt && new Date(b.trialEndsAt) < new Date()) return { status: "expired", label: "Expired", className: "status-expired" };
  return { status: "trial", label: "Trial", className: "status-trial" };
}
function formatTrialEnd(trialEndsAt) {
  if (!trialEndsAt) return "—";
  try {
    const d = new Date(trialEndsAt);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch (_) { return "—"; }
}
async function load() {
  const loading = document.getElementById("loading");
  const content = document.getElementById("content");
  const filterRow = document.getElementById("filter-row");
  try {
    const r = await fetch("/businesses", { headers: replyrAdminHeaders(false), credentials: "same-origin" });
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0) {
      content.innerHTML = "<p class=\\"empty\\">No businesses yet. Have them connect via the auth link.</p>";
    } else {
      const tableHtml = "<div class=\\"table-wrap\\"><table><thead><tr><th>Name</th><th>Contact (for 1–3 star replies)</th><th>Trial ends</th><th>Status</th><th>Pro</th><th>Pro tier (SMS/mo)</th><th>Auto-reply</th><th>Interval (min)</th><th>Actions</th></tr></thead><tbody></tbody></table></div>";
      content.insertAdjacentHTML("beforeend", tableHtml);
      const tableWrap = content.querySelector(".table-wrap");
      if (filterRow) { content.insertBefore(filterRow, tableWrap); filterRow.style.display = "flex"; }
      const tbody = content.querySelector("tbody");
      list.forEach(b => {
        const s = getStatus(b);
        const trialEndStr = formatTrialEnd(b.trialEndsAt);
        const tr = document.createElement("tr");
        tr.dataset.accountId = b.accountId;
        tr.dataset.locationId = b.locationId || "";
        tr.dataset.status = s.status;
        var tier = String(b.proTier || "starter").toLowerCase();
        if (["starter", "growth", "scale"].indexOf(tier) === -1) tier = "starter";
        tr.innerHTML = "<td>" + escapeHtml(b.name || "—") + "</td>" +
          "<td><input type=\\"text\\" value=\\"" + escapeAttr(b.contact || "") + "\\" data-field=\\"contact\\"></td>" +
          "<td>" + escapeHtml(trialEndStr) + "</td>" +
          "<td><span class=\\"" + s.className + "\\">" + escapeHtml(s.label) + "</span></td>" +
          "<td><input type=\\"checkbox\\" " + (b.isPro ? "checked" : "") + " data-field=\\"isPro\\" title=\\"Pro (campaigns, CSV)\\"></td>" +
          "<td><select data-field=\\"proTier\\" title=\\"Pro campaign SMS allowance (see /subscribe)\\">" + proTierSelectInnerHtml(tier) + "</select></td>" +
          "<td><input type=\\"checkbox\\" " + (b.autoReplyEnabled ? "checked" : "") + " data-field=\\"autoReplyEnabled\\"></td>" +
          "<td><input type=\\"number\\" min=\\"1\\" value=\\""
          + (b.intervalMinutes ?? 30)
          + "\\" data-field=\\"intervalMinutes\\"></td>" +
          "<td><div class=\\"actions-cell\\"><button type=\\"button\\" data-save>Save</button><button type=\\"button\\" data-run-now title=\\"Run Claude auto-reply now\\">Run now</button><a href=\\"#\\" data-pro-link title=\\"Open Pro campaigns page\\">Pro</a></div><span class=\\"msg\\" data-msg></span></td>";
        tbody.appendChild(tr);
      });
      content.querySelectorAll("[data-save]").forEach(btn => { btn.addEventListener("click", saveRow); });
      content.querySelectorAll("[data-run-now]").forEach(btn => { btn.addEventListener("click", runNowRow); });
      content.querySelectorAll("[data-pro-link]").forEach(function(a) {
        a.addEventListener("click", function(e) { e.preventDefault(); var tr = a.closest("tr"); if (tr && tr.dataset.accountId) window.open("/pro?accountId=" + encodeURIComponent(tr.dataset.accountId), "_blank"); });
      });
      var statusFilter = document.getElementById("status-filter");
      if (statusFilter) {
        statusFilter.addEventListener("change", function() {
          var val = statusFilter.value;
          content.querySelectorAll("tbody tr").forEach(function(tr) {
            tr.style.display = (!val || tr.dataset.status === val) ? "" : "none";
          });
        });
      }
    }
  } catch (e) {
    content.innerHTML = "<p class=\\"msg err\\">Failed to load: " + escapeHtml(e.message) + "</p>";
  }
  loading.style.display = "none";
  content.style.display = "block";
}
async function saveRow(e) {
  const btn = e.target;
  const tr = btn.closest("tr");
  const accountId = tr.dataset.accountId;
  const locationId = tr.dataset.locationId || "";
  const contact = tr.querySelector("[data-field=contact]").value.trim();
  const isPro = tr.querySelector("[data-field=isPro]").checked;
  const proTier = tr.querySelector("[data-field=proTier]").value;
  const autoReplyEnabled = tr.querySelector("[data-field=autoReplyEnabled]").checked;
  const intervalMinutes = parseInt(tr.querySelector("[data-field=intervalMinutes]").value, 10) || 30;
  const msgEl = tr.querySelector("[data-msg]");
  msgEl.textContent = "";
  msgEl.className = "msg";
  btn.disabled = true;
  try {
    const r = await fetch("/businesses/" + encodeURIComponent(accountId), {
      method: "PATCH",
      headers: replyrAdminHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify({ locationId, contact, isPro, proTier, autoReplyEnabled, intervalMinutes })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    msgEl.textContent = "Saved.";
    msgEl.className = "msg ok";
  } catch (err) {
    msgEl.textContent = err.message || "Error";
    msgEl.className = "msg err";
  }
  btn.disabled = false;
}
async function runNowRow(e) {
  const btn = e.target;
  const tr = btn.closest("tr");
  const accountId = tr.dataset.accountId;
  const locationId = tr.dataset.locationId;
  const msgEl = tr.querySelector("[data-msg]");
  msgEl.textContent = "";
  msgEl.className = "msg";
  if (!locationId) {
    msgEl.textContent = "No location";
    msgEl.className = "msg err";
    return;
  }
  btn.disabled = true;
  try {
    const r = await fetch("/auto/process", {
      method: "POST",
      headers: replyrAdminHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify({ accountId, locationId })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    const res = data.result || {};
    var txt = "Done. Attempted: " + (res.attempted || 0) + ", succeeded: " + (res.succeeded || 0) + ", failed: " + (res.failed || 0);
    if ((res.failed || 0) > 0 && Array.isArray(res.details)) {
      var errDetail = res.details.find(function(d) { return d.status === "error" && d.message; });
      if (errDetail) txt += " — " + errDetail.message;
    }
    msgEl.textContent = txt;
    msgEl.className = (res.failed || 0) > 0 ? "msg err" : "msg ok";
  } catch (err) {
    msgEl.textContent = err.message || "Error";
    msgEl.className = "msg err";
  }
  btn.disabled = false;
}
load();
  `;
}

// Admin metrics page (/admin/metrics). MRR / funnel / activity dashboard.
export function renderAdminMetricsHtml(data) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const cents = (c) => formatCentsAsUsd(c);
  const counts = data.mrr.countsByPlan;
  const planRow = (label, key) =>
    `<tr><td>${label}</td><td class="num">${counts[key] || 0}</td><td class="num">${cents(data.mrr.byPlanCents[key] || 0)}</td></tr>`;
  const planConfigWarnings = [
    !data.planAmountsConfigured.base && "STRIPE_BASE_PRICE_AMOUNT_CENTS",
    !data.planAmountsConfigured.proStarter && "STRIPE_PRO_STARTER_AMOUNT_CENTS",
    !data.planAmountsConfigured.proGrowth && "STRIPE_PRO_GROWTH_AMOUNT_CENTS",
    !data.planAmountsConfigured.proScale && "STRIPE_PRO_SCALE_AMOUNT_CENTS"
  ].filter(Boolean);
  const warningHtml = planConfigWarnings.length
    ? `<div class="warn">⚠ MRR may be undercounted — these env vars aren't set: ${planConfigWarnings.map((s) => `<code>${s}</code>`).join(", ")}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Replyr – Admin metrics</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>${adminBaseCss()}</style>
<style>
  .ts { color: var(--muted); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 600; margin-bottom: 16px; }
  .section-label { font-family: 'Fraunces', serif; font-size: 18px; font-weight: 400; color: var(--text); margin: 28px 0 14px; }
  .section-label:first-of-type { margin-top: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
    padding: 18px 20px; transition: border-color 0.18s, transform 0.18s;
    animation: fadeUp 0.4s ease both;
  }
  .stat-card:hover { border-color: rgba(255,255,255,0.12); transform: translateY(-1px); }
  .stat-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  .stat-value { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 300; color: var(--text); margin-top: 6px; line-height: 1.1; letter-spacing: -0.01em; }
  .stat-sub { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; overflow: hidden; animation: fadeUp 0.4s ease both; }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    background: var(--surface2); color: var(--muted);
    font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--border);
  }
  thead th.num, tbody td.num { text-align: right; }
  tbody td { padding: 11px 16px; border-bottom: 1px solid var(--border); font-size: 13px; color: var(--text); }
  tbody tr:last-child td { border-bottom: none; background: rgba(124,106,247,0.04); }
  tbody tr:last-child td strong { color: var(--text); }
  .warn {
    background: linear-gradient(135deg, rgba(245,159,11,0.12), rgba(245,159,11,0.06));
    border: 1px solid rgba(245,159,11,0.35); border-radius: 12px;
    padding: 12px 16px; font-size: 13px; color: #f5a55c; margin-bottom: 18px;
  }
  .warn code { color: #f5a55c; background: rgba(245,159,11,0.15); }
  .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted); }
  .footer a { color: var(--accent2); text-decoration: none; font-weight: 500; }
  .footer a:hover { color: #a099f7; text-decoration: underline; }
</style>
</head>
<body>
<div class="admin-wrap">
  ${adminNavHtml("metrics")}
  <div class="admin-page">
    <div class="admin-header">
      <h1>Metrics</h1>
      <p class="admin-subtitle">MRR, 30-day funnel, and current activity. MRR is computed locally from the <code>businesses</code> table using <code>STRIPE_*_AMOUNT_CENTS</code> env vars.</p>
      <div class="ts">As of ${escapeHtml(data.generatedAt)}</div>
    </div>

    ${warningHtml}

    <h2 class="section-label">Revenue</h2>
    <div class="grid">
      <div class="stat-card"><div class="stat-label">MRR</div><div class="stat-value">${cents(data.mrr.totalCents)}</div><div class="stat-sub">${data.mrr.activeSubscribers} active subscribers</div></div>
      <div class="stat-card"><div class="stat-label">Conversion (30d)</div><div class="stat-value">${pct(data.funnel.conversionRate)}</div><div class="stat-sub">${data.funnel.trialToPaid} of ${data.funnel.trialsStarted} trials in window</div></div>
      <div class="stat-card"><div class="stat-label">Active trials</div><div class="stat-value">${data.funnel.activeTrial}</div><div class="stat-sub">connected, in trial, not subscribed</div></div>
      <div class="stat-card"><div class="stat-label">Trial-end attrition</div><div class="stat-value">${data.funnel.trialEndedNoSub}</div><div class="stat-sub">trial ended, never subscribed</div></div>
    </div>

    <h2 class="section-label">Plans</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Plan</th><th class="num">Active</th><th class="num">MRR</th></tr></thead>
        <tbody>
          ${planRow("Base Replyr", "base")}
          ${planRow("Pro Starter", "pro_starter")}
          ${planRow("Pro Growth", "pro_growth")}
          ${planRow("Pro Scale", "pro_scale")}
          ${counts.pro_legacy ? planRow("Pro (legacy)", "pro_legacy") : ""}
          <tr><td><strong>Total paid</strong></td><td class="num"><strong>${data.mrr.activeSubscribers}</strong></td><td class="num"><strong>${cents(data.mrr.totalCents)}</strong></td></tr>
        </tbody>
      </table>
    </div>

    <h2 class="section-label">Activity</h2>
    <div class="grid">
      <div class="stat-card"><div class="stat-label">Connected businesses</div><div class="stat-value">${data.funnel.totalConnected}</div></div>
      <div class="stat-card"><div class="stat-label">Auto-reply enabled</div><div class="stat-value">${data.activity.autoReplyEnabledCount}</div></div>
      <div class="stat-card"><div class="stat-label">Preview/delayed mode</div><div class="stat-value">${data.activity.delayedModeCount}</div></div>
      <div class="stat-card"><div class="stat-label">Pending replies queued</div><div class="stat-value">${data.activity.pendingRepliesOpen}</div></div>
      <div class="stat-card"><div class="stat-label">Pro SMS this month</div><div class="stat-value">${data.activity.proSmsThisMonth.toLocaleString()}</div><div class="stat-sub">${escapeHtml(data.activity.monthKey)} · across all Pro tiers</div></div>
    </div>

    <div class="footer">JSON view: <a href="/admin/metrics.json">/admin/metrics.json</a></div>
  </div>
</div>
</body></html>`;
}
