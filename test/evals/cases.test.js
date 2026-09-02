"use strict";
// Regression cases seeded from failures that already happened.
//
// A narrative lesson is a story; a case is what makes the lesson STAY fixed.
// Each directory under evals/cases/ pairs a `case.json` — what happened, when,
// what it cost, which guard now prevents it — with a `case.js` that exercises
// that guard for real. No mocks of the thing under test: a case that passes
// against a stub proves nothing about the code that ships.
//
// THE GATE THAT MAKES THIS WORTH HAVING: every case must go RED when its guard
// is deleted. That is not assumed here — it is proven by hand and recorded in
// evals/README.md, because `promote-run.test.js` demonstrated that eighteen
// green tests can kill zero mutants when the fixtures share the code's own
// wrong belief.
//
// This file is discovered by `npm test` (test/**/*.test.*), so the cases are
// part of `npm run check` rather than a suite someone has to remember to run.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "../..");
const CASES_DIR = path.join(REPO, "evals/cases");

const caseIds = fs.readdirSync(CASES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

test("the case corpus is not empty", () => {
  // A discovery bug that finds zero cases would otherwise report a green suite.
  assert.ok(caseIds.length >= 6,
    `expected the six seeded failures, found ${caseIds.length}: ${caseIds.join(", ")}`);
});

for (const id of caseIds) {
  const dir = path.join(CASES_DIR, id);

  test(`${id}: declares what happened, and which guard now prevents it`, () => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "case.json"), "utf8"));
    assert.equal(meta.id, id, "the declared id must match the directory");
    for (const field of ["title", "incident", "guard", "trigger", "assertion"]) {
      assert.ok(meta[field], `case.json is missing ${field}`);
    }
    assert.ok(meta.incident.record, "an incident with no record cannot be checked by a reader");
    assert.ok(meta.incident.mechanism, "name the mechanism; 'it broke' teaches nothing");

    // PROVENANCE MUST RESOLVE. A case pointing at a guard that no longer exists
    // is a case that cannot fail, and it would sit green forever.
    const guardFile = path.join(REPO, meta.guard.module);
    assert.ok(fs.existsSync(guardFile), `guard module ${meta.guard.module} does not exist`);
    const symbol = String(meta.guard.symbol).split(".").pop();
    assert.match(fs.readFileSync(guardFile, "utf8"), new RegExp(`\\b${symbol}\\b`),
      `guard symbol ${meta.guard.symbol} is not present in ${meta.guard.module}`);
  });

  test(`${id}: the guard still holds`, async () => {
    const mod = require(path.join(dir, "case.js"));
    assert.equal(typeof mod.run, "function", "case.js must export run()");
    await mod.run();
  });
}
