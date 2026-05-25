/**
 * Sentry wrapper. No-op when SENTRY_DSN is unset — keeps local dev and any
 * environment without a DSN running unchanged.
 *
 * Loaded lazily so the dependency is only imported when actually configured.
 */

let sentry = null;
let initPromise = null;

function dsn() {
  return (process.env.SENTRY_DSN || "").trim();
}

export function isEnabled() {
  return Boolean(dsn());
}

/**
 * Initialize Sentry once. Safe to call on every server start.
 * Returns the Sentry module if initialized, otherwise null.
 */
export async function init() {
  if (!isEnabled()) return null;
  if (sentry) return sentry;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const mod = await import("@sentry/node");
    mod.init({
      dsn: dsn(),
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
      release: process.env.SENTRY_RELEASE || undefined,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      sendDefaultPii: false
    });
    sentry = mod;
    return mod;
  })();
  return initPromise;
}

/** Express request handler — must be the first middleware when enabled. */
export function requestHandler() {
  return (req, _res, next) => {
    if (sentry?.getCurrentScope) {
      sentry.getCurrentScope().setTag("path", req.path);
    }
    next();
  };
}

/** Express error handler — install before the app's catch-all. */
export function errorHandler() {
  return (err, _req, _res, next) => {
    if (sentry && err) {
      const status = err.status || err.statusCode;
      if (!status || status >= 500) {
        sentry.captureException(err);
      }
    }
    next(err);
  };
}

/** Capture an exception from a non-request context (scheduler, webhook). */
export function captureException(err, context = {}) {
  if (!sentry) return;
  try {
    sentry.withScope((scope) => {
      for (const [k, v] of Object.entries(context)) {
        scope.setExtra(k, v);
      }
      sentry.captureException(err);
    });
  } catch {
    /* never throw from telemetry */
  }
}

/** Flush queued events before process exits. */
export async function flush(timeoutMs = 2000) {
  if (!sentry?.flush) return;
  try {
    await sentry.flush(timeoutMs);
  } catch {
    /* ignore */
  }
}
