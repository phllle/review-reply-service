import { test } from "node:test";
import assert from "node:assert/strict";
import { getProcessPendingReviewOptions } from "../src/auto.js";

test("getProcessPendingReviewOptions carries preview-mode settings", () => {
  const logger = { info() {} };
  const opts = getProcessPendingReviewOptions(
    {
      name: "Preview Shop",
      contact: "owner@example.com",
      autoReplyMode: "delayed",
      notificationEmail: "alerts@example.com"
    },
    logger
  );

  assert.deepEqual(opts, {
    contact: "owner@example.com",
    businessName: "Preview Shop",
    logger,
    autoReplyMode: "delayed",
    ownerEmail: "alerts@example.com"
  });
});

test("getProcessPendingReviewOptions defaults to instant mode", () => {
  const opts = getProcessPendingReviewOptions(null);

  assert.equal(opts.contact, undefined);
  assert.equal(opts.businessName, "our business");
  assert.equal(opts.autoReplyMode, "instant");
  assert.equal(opts.ownerEmail, null);
});
