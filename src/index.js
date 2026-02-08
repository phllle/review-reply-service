import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";
import * as db from "./db.js";
import { getAuthUrl, handleOAuthCallback, getTokenStatus, replyToReview, listAccounts, listLocations, listReviews } from "./google.js";
import { processPendingReviews, startScheduler } from "./auto.js";
import { getAllBusinesses, getBusiness, upsertBusiness } from "./businesses.js";

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

async function start() {
  if (db.useDb()) {
    await db.init();
    logger.info("Database initialized");
  }
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    logger.info({ port }, "Server started");
    startScheduler(logger);
  });
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (allowedOrigins.includes("*")) return callback(null, true);
    if (!origin) return callback(null, false);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true
};

app.use(helmet());
app.use(cors(corsOptions));
app.use(pinoHttp({ logger }));
app.use(express.json());

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.get("/auth/google", async (req, res, next) => {
  try {
    const url = await getAuthUrl();
    res.redirect(url);
  } catch (err) {
    req.log.error(err, "Failed to get Google auth URL");
    next(err);
  }
});

app.get("/auth/google/callback", async (req, res, next) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).json({ error: "Missing code" });
    }
    const { accountId, accountName } = await handleOAuthCallback(code.toString());
    const locations = await listLocations(accountId);
    const firstLocation = locations[0];
    const locationId = firstLocation?.name
      ? firstLocation.name.split("/").pop()
      : null;
    const name = firstLocation?.title || accountName || null;
    await upsertBusiness({
      accountId,
      locationId: locationId || "",
      name
    });
    res.json({
      ok: true,
      message: "Google connected",
      accountId,
      locationId,
      businessName: name
    });
  } catch (err) {
    req.log.error(err, "OAuth callback failed");
    next(err);
  }
});

app.get("/me/google", async (req, res, next) => {
  try {
    const accountId = req.query.accountId || undefined;
    const status = await getTokenStatus(accountId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

app.get("/businesses", async (req, res, next) => {
  try {
    const list = await getAllBusinesses();
    const businesses = Object.values(list);
    res.json(businesses);
  } catch (err) {
    next(err);
  }
});

app.patch("/businesses/:accountId", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const existing = await getBusiness(accountId);
    if (!existing) {
      return res.status(404).json({ error: "Business not found. Connect via /auth/google first." });
    }
    const { autoReplyEnabled, contact, intervalMinutes } = req.body || {};
    await upsertBusiness({
      ...existing,
      ...(typeof autoReplyEnabled === "boolean" && { autoReplyEnabled }),
      ...(contact !== undefined && { contact: String(contact) }),
      ...(intervalMinutes !== undefined && { intervalMinutes: Number(intervalMinutes) })
    });
    const updated = await getBusiness(accountId);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Admin page: list businesses, edit contact and auto-reply
app.get("/admin", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Review Reply – Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 1.5rem; background: #f5f5f5; }
    h1 { margin: 0 0 1rem; font-size: 1.25rem; color: #333; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #fafafa; font-weight: 600; color: #555; font-size: 0.8rem; text-transform: uppercase; }
    tr:last-child td { border-bottom: none; }
    input[type="text"], input[type="number"] { width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; font-size: 0.9rem; }
    input[type="checkbox"] { width: 1.1rem; height: 1.1rem; }
    button { padding: 0.5rem 1rem; background: #333; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
    button:hover { background: #555; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .msg { margin-top: 0.5rem; font-size: 0.85rem; }
    .msg.ok { color: #0a0; }
    .msg.err { color: #c00; }
    .empty { color: #888; padding: 2rem; text-align: center; }
    .refresh { margin-bottom: 1rem; }
  </style>
</head>
<body>
  <h1>Review Reply – Admin</h1>
  <p class="refresh"><a href="/admin">Refresh</a> · <a href="/businesses">JSON</a></p>
  <div id="loading">Loading businesses…</div>
  <div id="content" style="display: none;"></div>
  <script src="/admin.js"></script>
</body>
</html>
  `);
});

// Admin script (separate so CSP allows it)
app.get("/admin.js", (req, res) => {
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.send(`
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
async function load() {
  const loading = document.getElementById("loading");
  const content = document.getElementById("content");
  try {
    const r = await fetch("/businesses");
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0) {
      content.innerHTML = "<p class=\\"empty\\">No businesses yet. Have them connect via the auth link.</p>";
    } else {
      content.innerHTML = "<table><thead><tr><th>Name</th><th>Contact (for 1–2 star replies)</th><th>Auto-reply</th><th>Interval (min)</th><th></th></tr></thead><tbody></tbody></table>";
      const tbody = content.querySelector("tbody");
      list.forEach(b => {
        const tr = document.createElement("tr");
        tr.dataset.accountId = b.accountId;
        tr.innerHTML = "<td>" + escapeHtml(b.name || "—") + "</td>" +
          "<td><input type=\\"text\\" value=\\"" + escapeAttr(b.contact || "") + "\\" data-field=\\"contact\\"></td>" +
          "<td><input type=\\"checkbox\\" " + (b.autoReplyEnabled ? "checked" : "") + " data-field=\\"autoReplyEnabled\\"></td>" +
          "<td><input type=\\"number\\" min=\\"1\\" value=\\""
          + (b.intervalMinutes ?? 30)
          + "\\" data-field=\\"intervalMinutes\\" style=\\"width:4rem\\"></td>" +
          "<td><button type=\\"button\\" data-save>Save</button><span class=\\"msg\\" data-msg></span></td>";
        tbody.appendChild(tr);
      });
      content.querySelectorAll("[data-save]").forEach(btn => {
        btn.addEventListener("click", saveRow);
      });
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
  const contact = tr.querySelector("[data-field=contact]").value.trim();
  const autoReplyEnabled = tr.querySelector("[data-field=autoReplyEnabled]").checked;
  const intervalMinutes = parseInt(tr.querySelector("[data-field=intervalMinutes]").value, 10) || 30;
  const msgEl = tr.querySelector("[data-msg]");
  msgEl.textContent = "";
  msgEl.className = "msg";
  btn.disabled = true;
  try {
    const r = await fetch("/businesses/" + encodeURIComponent(accountId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, autoReplyEnabled, intervalMinutes })
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
load();
  `);
});

app.post("/google/reviews/:accountId/:locationId/:reviewId/reply", async (req, res, next) => {
  try {
    const { accountId, locationId, reviewId } = req.params;
    const { comment } = req.body || {};
    if (!comment || typeof comment !== "string" || comment.trim().length === 0) {
      return res.status(400).json({ error: "comment is required" });
    }
    const result = await replyToReview(accountId, locationId, reviewId, comment.trim());
    res.json({ ok: true, result });
  } catch (err) {
    req.log.error(err, "Failed to reply to review");
    next(err);
  }
});

app.get("/google/accounts", async (req, res, next) => {
  try {
    const accounts = await listAccounts();
    res.json(accounts);
  } catch (err) {
    req.log.error(err, "Failed to list accounts");
    next(err);
  }
});

app.get("/google/accounts/:accountId/locations", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const locations = await listLocations(accountId);
    res.json(locations);
  } catch (err) {
    req.log.error(err, "Failed to list locations");
    next(err);
  }
});

app.get("/google/accounts/:accountId/locations/:locationId/reviews", async (req, res, next) => {
  try {
    const { accountId, locationId } = req.params;
    const reviews = await listReviews(accountId, locationId);
    res.json(reviews);
  } catch (err) {
    req.log.error(err, "Failed to list reviews");
    next(err);
  }
});

// Manual trigger for auto-replies (body: accountId, locationId — or env fallback)
app.post("/auto/process", async (req, res, next) => {
  try {
    const { getBusiness } = await import("./businesses.js");
    const { accountId, locationId } = req.body || {};
    const a = accountId || process.env.AUTO_REPLY_ACCOUNT_ID;
    const l = locationId || process.env.AUTO_REPLY_LOCATION_ID;
    if (!a || !l) {
      return res.status(400).json({ error: "accountId and locationId required (body or env)" });
    }
    const business = await getBusiness(a);
    const result = await processPendingReviews(a, l, {
      contact: business?.contact,
      logger: req.log
    });
    res.json({ ok: true, result });
  } catch (err) {
    req.log.error(err, "Auto process failed");
    next(err);
  }
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Internal Server Error" });
});

start().catch((err) => {
  logger.fatal(err, "Startup failed");
  process.exit(1);
});
