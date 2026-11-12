import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWidgetPayload,
  loadWidgetPayload,
  ensureWidgetToken,
  generateWidgetToken,
  buildWidgetScript,
  WIDGET_NOOP_SCRIPT,
  WIDGET_POWERED_BY_URL
} from "../src/reviewWidget.js";

const business = {
  accountId: "acct-1",
  locationId: "loc-1",
  name: "Castle Nail Bar",
  placeId: "ChIJ123abc",
  widgetToken: "tok123"
};

const review = (over) => ({
  reviewer: { displayName: "Pat" },
  starRating: "FIVE",
  comment: "Lovely place",
  createTime: "2026-11-01T10:00:00Z",
  ...over
});

test("buildWidgetPayload: average + total count span ALL reviews, not just shown ones", () => {
  const payload = buildWidgetPayload(business, [
    review({ starRating: "FIVE", comment: "Great" }),
    review({ starRating: "FOUR", comment: "" }),
    review({ starRating: "TWO", comment: "Meh", createTime: "2026-11-02T10:00:00Z" })
  ]);
  assert.equal(payload.averageRating, 3.7); // (5+4+2)/3 = 3.66… → 3.7
  assert.equal(payload.totalReviews, 3);
  assert.equal(payload.businessName, "Castle Nail Bar");
  assert.equal(payload.poweredBy, WIDGET_POWERED_BY_URL);
  assert.ok(payload.googleUrl.includes("query_place_id=ChIJ123abc"));
});

test("buildWidgetPayload: 5 most recent reviews WITH text, newest first, low stars included", () => {
  const reviews = [];
  for (let i = 1; i <= 7; i++) {
    reviews.push(
      review({
        reviewer: { displayName: `R${i}` },
        starRating: i === 7 ? "ONE" : "FIVE",
        comment: `Review ${i}`,
        createTime: `2026-11-0${i}T10:00:00Z`
      })
    );
  }
  // Most recent overall, but no text — must not take a slot.
  reviews.push(review({ comment: "", createTime: "2026-11-09T10:00:00Z" }));
  const payload = buildWidgetPayload(business, reviews);
  assert.equal(payload.totalReviews, 8);
  assert.equal(payload.reviews.length, 5);
  assert.deepEqual(
    payload.reviews.map((r) => r.reviewer),
    ["R7", "R6", "R5", "R4", "R3"]
  );
  assert.equal(payload.reviews[0].rating, 1); // the 1-star review is shown, not hidden
});

test("buildWidgetPayload: review text truncated to 220 chars with ellipsis", () => {
  const payload = buildWidgetPayload(business, [review({ comment: "x".repeat(400) })]);
  assert.equal(payload.reviews[0].text.length, 220);
  assert.ok(payload.reviews[0].text.endsWith("…"));
});

test("buildWidgetPayload: null business → null; zero reviews → empty payload", () => {
  assert.equal(buildWidgetPayload(null, []), null);
  assert.equal(buildWidgetPayload(undefined, [review({})]), null);
  const payload = buildWidgetPayload(business, []);
  assert.equal(payload.totalReviews, 0);
  assert.equal(payload.averageRating, null);
  assert.deepEqual(payload.reviews, []);
});

test("loadWidgetPayload: unknown token → null; Google failure → null; happy path builds payload", async () => {
  const logger = { warn() {} };
  const unknown = await loadWidgetPayload("nope", {
    logger,
    deps: { getBusinessByWidgetToken: async () => null }
  });
  assert.equal(unknown, null);

  const failed = await loadWidgetPayload("tok123", {
    logger,
    deps: {
      getBusinessByWidgetToken: async () => business,
      listReviews: async () => {
        throw new Error("google down");
      }
    }
  });
  assert.equal(failed, null);

  const ok = await loadWidgetPayload("tok123", {
    logger,
    deps: {
      getBusinessByWidgetToken: async () => business,
      listReviews: async () => [review({})]
    }
  });
  assert.equal(ok.businessName, "Castle Nail Bar");
  assert.equal(ok.totalReviews, 1);
});

test("ensureWidgetToken: generates once and stamps every location row", async () => {
  const rows = [
    { accountId: "acct-1", locationId: "loc-1", widgetToken: null },
    { accountId: "acct-1", locationId: "loc-2", widgetToken: null }
  ];
  const stamps = [];
  const token = await ensureWidgetToken("acct-1", {
    logger: { info() {} },
    deps: {
      getBusinessesForAccount: async () => rows,
      upsertBusiness: async (cfg) => {
        stamps.push(cfg);
      }
    }
  });
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(stamps.length, 2);
  assert.ok(stamps.every((s) => s.widgetToken === token));

  // Existing token: returned as-is, no writes.
  const stamps2 = [];
  const again = await ensureWidgetToken("acct-1", {
    logger: { info() {} },
    deps: {
      getBusinessesForAccount: async () => [{ accountId: "acct-1", locationId: "loc-1", widgetToken: "existing" }],
      upsertBusiness: async (cfg) => {
        stamps2.push(cfg);
      }
    }
  });
  assert.equal(again, "existing");
  assert.equal(stamps2.length, 0);

  assert.notEqual(generateWidgetToken(), generateWidgetToken());
});

test("buildWidgetScript: renders via textContent (never innerHTML) and carries the token", () => {
  const script = buildWidgetScript("tok123");
  assert.ok(script.includes("tok123"));
  assert.ok(script.includes("textContent"));
  assert.ok(!script.includes("innerHTML"));
  assert.ok(script.includes("data-replyr-widget"));
  assert.ok(WIDGET_NOOP_SCRIPT.trimStart().startsWith("/*"));
});
