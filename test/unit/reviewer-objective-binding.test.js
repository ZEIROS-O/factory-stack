"use strict";
// The Reviewer must review the objective bound to the issue it was dispatched
// for — never a committed file.
//
// THE DEFECT THIS FILE PINS. The reviewer tool used to open
//
//     loadContract(path.join(FACTORY_ROOT, "contracts/objectives/ZEI-1.json"))
//
// so a Hermes-created ZEI-2 was reviewed against ZEI-1's acceptance criteria,
// or (once criteria ids stopped matching) could not be reviewed at all.
//
// WHY THESE ARE SOURCE ASSERTIONS. The tool is a TypeScript module OMP loads
// in-process through `--extension`; node:test cannot execute it without OMP's
// loader, and the behaviour that matters here is which path it reads, not what
// it computes. lib/objective.js carries the executable tests for the
// resolution itself (test/unit/objective.test.js). These assertions exist to
// stop the hardcoding from being reintroduced, which is how it arrived.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const TOOL = path.join(__dirname, "../../omp/plugins/paperclip-review/tools/paperclip_review/index.ts");
const source = fs.readFileSync(TOOL, "utf8");

/** Comments explain the old defect on purpose; only real code is asserted on. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

test("the reviewer tool names no objective file on disk", () => {
  assert.doesNotMatch(code, /contracts\/objectives/,
    "the reviewer must not read a committed objective; the issue's spec document is the objective of record");
});

test("the reviewer tool names no specific issue identifier", () => {
  assert.doesNotMatch(code, /ZEI-\d+/,
    "an issue identifier in the reviewer's code is the hardcoding defect returning");
});

test("the reviewer tool resolves its objective through the shared resolver", () => {
  assert.match(code, /resolveObjectiveForIssue/,
    "the reviewer must use lib/objective.js so it and factory promote cannot drift");
});

test("the reviewer refuses an issue that returns no identifier", () => {
  // resolveObjectiveForIssue skips its identifier binding when no identifier is
  // supplied — correct for callers that genuinely have none, wrong here. The
  // binding is the only check that catches a spec document misfiled onto
  // another issue, and losing it SILENTLY is the same class of defect as the
  // hardcoding this change removed. `identifier` is a real column on the
  // issues table (packages/db/src/schema/issues.ts), so its absence means the
  // response shape moved, which the reviewer must report rather than absorb.
  assert.match(code, /issue\.identifier/,
    "the reviewer must pass the issue identifier to the resolver");
  assert.match(code, /PAPERCLIP_REVIEW_NO_IDENTIFIER|carries no identifier/,
    "the reviewer must fail closed when the issue carries no identifier");
});
