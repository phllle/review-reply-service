import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ogPath = path.join(dir, "..", "public", "og.jpg");

/** Branded 1200x630 Open Graph / iMessage card. */
export function registerBrandOg(app) {
  const send = (_req, res) => {
    if (!fs.existsSync(ogPath)) {
      res.status(404).type("text/plain").send("og image missing");
      return;
    }
    res.set("Cache-Control", "public, max-age=86400");
    res.type("image/jpeg");
    res.send(fs.readFileSync(ogPath));
  };
  app.get("/og.jpg", send);
  // Old iMessage URL — same card so cached previews update after expiry.
  app.get("/review-example-1-og.jpg", send);
}
