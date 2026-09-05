import test from "node:test";
import assert from "node:assert/strict";
import { publicContactEmail, publicContactMailtoHref, PUBLIC_CONTACT_EMAIL } from "../src/publicContact.js";

test("defaults to hello@replyr.pro", () => {
  const prev = process.env.REPLYR_CONTACT;
  delete process.env.REPLYR_CONTACT;
  assert.equal(PUBLIC_CONTACT_EMAIL, "hello@replyr.pro");
  assert.equal(publicContactEmail(), "hello@replyr.pro");
  assert.equal(publicContactMailtoHref(), "mailto:hello@replyr.pro");
  if (prev === undefined) delete process.env.REPLYR_CONTACT;
  else process.env.REPLYR_CONTACT = prev;
});
