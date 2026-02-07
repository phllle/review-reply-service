import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";
import { getAuthUrl, handleOAuthCallback, getTokenStatus, replyToReview, listAccounts, listLocations, listReviews } from "./google.js";
import { processPendingReviews, startScheduler } from "./auto.js";

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

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
    await handleOAuthCallback(code.toString());
    res.json({ ok: true, message: "Google connected" });
  } catch (err) {
    req.log.error(err, "OAuth callback failed");
    next(err);
  }
});

app.get("/me/google", async (req, res, next) => {
  try {
    const status = await getTokenStatus();
    res.json(status);
  } catch (err) {
    next(err);
  }
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

// Manual trigger for auto-replies
app.post("/auto/process", async (req, res, next) => {
  try {
    const { accountId, locationId } = req.body || {};
    const a = accountId || process.env.AUTO_REPLY_ACCOUNT_ID;
    const l = locationId || process.env.AUTO_REPLY_LOCATION_ID;
    if (!a || !l) {
      return res.status(400).json({ error: "accountId and locationId required (body or env)" });
    }
    const result = await processPendingReviews(a, l, req.log);
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

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  logger.info({ port }, "Server started");
  // Start optional scheduler
  startScheduler(logger);
});
