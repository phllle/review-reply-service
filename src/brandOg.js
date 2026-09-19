/** Branded 1200x630 Open Graph / iMessage preview. */
export function registerBrandOg(app) {
  const send = (_req, res) => {
    res.status(503).type("text/plain").send("og image missing");
  };
  app.get("/og.jpg", send);
}
