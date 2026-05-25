import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

process.env.REPLYR_SESSION_SECRET = "test-subscribe-session-secret";

const { setSessionCookie } = await import("../src/sessionAuth.js");

function fakeRes() {
  const headers = {};
  return {
    headers,
    append(key, value) {
      headers[key] = headers[key] ? [].concat(headers[key], value) : value;
    }
  };
}

function getSetCookieHeader(accountId) {
  const res = fakeRes();
  setSessionCookie(res, accountId);
  const sc = res.headers["Set-Cookie"];
  return Array.isArray(sc) ? sc[0] : sc;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before readiness with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/subscribe`);
      if (res.ok) return;
      lastError = new Error(`readiness returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("server did not become ready");
}

async function startServer() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      REPLYR_SESSION_SECRET: process.env.REPLYR_SESSION_SECRET,
      STRIPE_SECRET_KEY: "sk_test_subscribe",
      STRIPE_PRICE_ID: "price_subscribe",
      AUTO_REPLY_ENABLED: "false",
      DATABASE_URL: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.resume();
  child.stderr.resume();
  await waitForServer(baseUrl, child);
  return { baseUrl, child };
}

let server;

after(async () => {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  await new Promise((resolve) => server.child.once("exit", resolve));
});

test("subscribe page uses signed session accountId when OAuth returns without query params", async () => {
  server = await startServer();
  const accountId = "acct-subscribe-session";
  const res = await fetch(`${server.baseUrl}/subscribe`, {
    headers: {
      Cookie: getSetCookieHeader(accountId)
    }
  });

  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(`data-account-id="${accountId}"`));
  assert.match(html, /data-base-requires-account="1"/);
});
