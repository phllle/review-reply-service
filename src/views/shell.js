/**
 * Shared HTML shell + escaping helpers used by index.js and the view modules
 * (publicPages, adminPage). Extracted verbatim from index.js — no behavior change.
 */

export function escapeHtml(s) {
  const d = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return String(s).replace(/[&<>"]/g, (c) => d[c]);
}

// Shared dark-brand shell for the simple static-style pages
// (no-business, contact, compliance, privacy, terms).
// Body content is rendered inside .doc-card.
export function darkShellHtml({ title, bodyHtml, narrow = false, description = "", canonicalPath = "" }) {
  const pageWidth = narrow ? "440px" : "720px";
  const descMeta = description
    ? `<meta name="description" content="${escapeHtml(description)}">`
    : "";
  const canonicalMeta = canonicalPath
    ? `<link rel="canonical" href="https://replyr.pro${escapeHtml(canonicalPath)}">`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
${descMeta}
${canonicalMeta}
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<noscript><link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"></noscript>
<style>
  :root { --bg: #0f0f11; --surface: #17171a; --surface2: #1e1e22; --border: rgba(255,255,255,0.07); --accent: #4a9eff; --accent2: #7c6af7; --text: #f0ede8; --muted: #8b8a92; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .skip-link { position: absolute; left: -9999px; top: 0; z-index: 200; background: var(--accent); color: #0f0f11; padding: 10px 16px; border-radius: 0 0 10px 0; font-weight: 700; font-size: 14px; text-decoration: none; }
  .skip-link:focus { left: 0; }
  .doc-footer { max-width: ${pageWidth}; margin: 24px auto 0; text-align: center; font-size: 12px; color: var(--muted); position: relative; z-index: 1; }
  .doc-footer a { color: var(--muted); text-decoration: underline; }
  .doc-footer a:hover { color: var(--text); }
  body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 15px; min-height: 100vh; padding: 48px 24px 80px; overflow-x: hidden; line-height: 1.6; }
  body::before { content: ''; position: fixed; top: -200px; left: 50%; transform: translateX(-50%); width: 800px; height: 500px; background: radial-gradient(ellipse, rgba(124,106,247,0.12) 0%, transparent 70%); pointer-events: none; z-index: 0; }
  .doc-wrap { max-width: ${pageWidth}; margin: 0 auto; position: relative; z-index: 1; }
  .doc-brand { display: flex; align-items: center; justify-content: center; gap: 9px; margin-bottom: 24px; }
  .doc-brand-icon { width: 30px; height: 30px; background: linear-gradient(135deg, var(--accent2), var(--accent)); border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 15px; }
  .doc-brand-name { font-size: 16px; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }
  .doc-card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 32px; animation: fadeUp 0.4s ease both; }
  .doc-card h1 { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 300; letter-spacing: -0.02em; color: var(--text); margin-bottom: 16px; line-height: 1.15; }
  .doc-card h1 em { color: var(--accent); font-style: italic; }
  .doc-card h2 { font-family: 'Fraunces', serif; font-size: 18px; font-weight: 400; color: var(--text); margin: 24px 0 10px; }
  .doc-card p { color: var(--muted); font-size: 14px; line-height: 1.7; margin-bottom: 14px; }
  .doc-card p strong { color: var(--text); font-weight: 600; }
  .doc-card a { color: var(--accent2); text-decoration: none; font-weight: 500; }
  .doc-card a:hover { color: #a099f7; text-decoration: underline; }
  .doc-card code { background: rgba(255,255,255,0.06); border-radius: 4px; padding: 1px 6px; font-size: 12px; color: var(--accent); font-family: ui-monospace, SFMono-Regular, monospace; }
  .doc-card .meta-stamp { color: var(--muted); font-size: 12px; margin-bottom: 18px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 600; }
  .doc-card .callout { background: var(--surface2); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; margin: 12px 0; }
  .doc-card .callout p:last-child { margin-bottom: 0; }
  .doc-card .callout strong { color: var(--text); }
  .doc-back { text-align: center; margin-top: 24px; font-size: 13px; color: var(--muted); }
  .doc-back a { color: var(--accent2); text-decoration: none; font-weight: 500; }
  .doc-back a:hover { color: #a099f7; text-decoration: underline; }
  .doc-btn { display: inline-flex; align-items: center; gap: 7px; margin-top: 6px; padding: 11px 20px; background: var(--accent); color: #0f0f11; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; transition: all 0.2s; }
  .doc-btn:hover { background: #6bafff; transform: translateY(-1px); box-shadow: 0 8px 30px rgba(74,158,255,0.25); color: #0f0f11; text-decoration: none; }
  .doc-card .contact-link { display: inline-block; margin-top: 4px; font-size: 16px; font-weight: 600; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="doc-wrap">
  <header class="doc-brand">
    <div class="doc-brand-icon" aria-hidden="true">💬</div>
    <span class="doc-brand-name">Replyr</span>
  </header>
  <main id="main" class="doc-card">
${bodyHtml}
  </main>
</div>
<footer class="doc-footer">
  <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/compliance">Messaging compliance</a>
</footer>
</body>
</html>`;
}

// Shared base CSS for /admin and /admin/metrics. Same dark brand as the rest of
// the app, but a wider wrapper than darkShellHtml since admin tables need room.
export function adminBaseCss() {
  return `
  :root { --bg: #0f0f11; --surface: #17171a; --surface2: #1e1e22; --border: rgba(255,255,255,0.07); --accent: #4a9eff; --accent2: #7c6af7; --text: #f0ede8; --muted: #7a7880; --danger: #ff6b6b; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 14px; min-height: 100vh; padding: 32px 24px 80px; overflow-x: hidden; line-height: 1.55; }
  body::before { content: ''; position: fixed; top: -200px; left: 50%; transform: translateX(-50%); width: 800px; height: 500px; background: radial-gradient(ellipse, rgba(124,106,247,0.12) 0%, transparent 70%); pointer-events: none; z-index: 0; }
  .admin-wrap { max-width: 1280px; margin: 0 auto; position: relative; z-index: 1; }
  .admin-nav { display: flex; align-items: center; gap: 18px; margin-bottom: 32px; flex-wrap: wrap; }
  .admin-brand { display: inline-flex; align-items: center; gap: 9px; text-decoration: none; color: var(--text); }
  .admin-brand-icon { width: 28px; height: 28px; background: linear-gradient(135deg, var(--accent2), var(--accent)); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .admin-brand-name { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
  .admin-tabs { display: inline-flex; gap: 4px; padding: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
  .admin-tab { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--muted); text-decoration: none; transition: all 0.18s; }
  .admin-tab:hover { color: var(--text); background: rgba(255,255,255,0.04); }
  .admin-tab.active { color: var(--text); background: linear-gradient(135deg, rgba(124,106,247,0.18), rgba(74,158,255,0.14)); border: 1px solid rgba(124,106,247,0.35); padding: 6px 13px; }
  .admin-page { animation: fadeUp 0.4s ease both; }
  .admin-header { margin-bottom: 24px; }
  .admin-header h1 { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 300; letter-spacing: -0.02em; line-height: 1.1; margin-bottom: 6px; }
  .admin-header h1 em { color: var(--accent); font-style: italic; }
  .admin-subtitle { color: var(--muted); font-size: 13px; max-width: 720px; line-height: 1.6; margin-bottom: 12px; }
  .admin-subtitle strong { color: var(--text); font-weight: 600; }
  .admin-tools { font-size: 13px; color: var(--muted); }
  .admin-tools a { color: var(--accent2); text-decoration: none; font-weight: 500; }
  .admin-tools a:hover { color: #a099f7; text-decoration: underline; }
  code { background: rgba(255,255,255,0.06); border-radius: 4px; padding: 1px 6px; font-size: 12px; color: var(--accent); font-family: ui-monospace, SFMono-Regular, monospace; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  `;
}

// Shared top nav for /admin and /admin/metrics. activeTab is "businesses" or
// "metrics". Auth rides on the HttpOnly admin cookie, so links carry no secret.
export function adminNavHtml(activeTab) {
  const cls = (id) => `admin-tab${activeTab === id ? " active" : ""}`;
  return `<nav class="admin-nav" aria-label="Admin">
      <a href="/admin" class="admin-brand">
        <span class="admin-brand-icon" aria-hidden="true">💬</span>
        <span class="admin-brand-name">Replyr admin</span>
      </a>
      <div class="admin-tabs" role="tablist">
        <a href="/admin" class="${cls("businesses")}" role="tab" aria-selected="${activeTab === "businesses"}">Businesses</a>
        <a href="/admin/metrics" class="${cls("metrics")}" role="tab" aria-selected="${activeTab === "metrics"}">Metrics</a>
      </div>
    </nav>`;
}
