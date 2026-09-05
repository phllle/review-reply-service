#!/usr/bin/env node
import fs from "fs";

const idx = "src/index.js";
let t = fs.readFileSync(idx, "utf8");

function add(oldStr, newStr, label) {
  if (t.includes(newStr.split("\n")[0]) && label !== "script") {
    console.log("skip", label);
    return;
  }
  if (!t.includes(oldStr)) {
    console.error("missing", label);
    process.exit(1);
  }
  t = t.replace(oldStr, newStr);
  console.log("applied", label);
}

add(
  'import { registerReviewFeed } from "./reviewFeed.js";',
  'import { registerReviewFeed } from "./reviewFeed.js";\nimport { registerReviewRequests } from "./reviewRequests.js";',
  "import"
);
add(
  "registerReviewFeed(app);",
  "registerReviewFeed(app);\nregisterReviewRequests(app);",
  "register"
);
add(
  '<script src="/pro.js"></script>',
  '<script src="/pro.js"></script>\n<script src="/review-requests.js"></script>',
  "script"
);
fs.writeFileSync(idx, t);
console.log("wired index.js");
