"use strict";
// A declared wall-clock limit and the override that enforces it must agree.
//
// WHAT THE INVESTIGATION FOUND (2026-09-02). The audit plan carried an open
// hypothesis: that per-issue `timeoutSec` never reaches the run, because ZEI-2
// declares `wallClockMinutes: 15` while every one of its 16 runs reported
// `effectiveTimeoutSec: 1800`.
//
// That reading is wrong, and the reason matters. `effectiveTimeoutSec` is
// produced by `mergeRunStopMetadataForAgent` in the shipped server, which
// builds it from `agent.adapterConfig` ALONE:
//
//     const stopMetadata = buildHeartbeatRunStopMetadata({
//       adapterType: agent.adapterType,
//       adapterConfig: parseObject(agent.adapterConfig),   // <- not the merge
//
// while the config the executor actually receives comes from
// `mergeModelProfileAdapterConfig`, which appends `issueAdapterConfig` LAST and
// therefore wins:
//
//     return { ...baseConfig, ...modelProfile.adapterConfig, ...issueAdapterConfig };
//
// So the reported field cannot reflect the issue override by construction. It
// is not evidence about the effective bound, and no conclusion — in either
// direction — may be drawn from it. `lib/retro.js` records it as reported-only
// for exactly this reason.
//
// WHAT IS ACTUALLY UNGUARDED is on this side. The bound reaches a run through
// `assigneeAdapterOverrides.adapterConfig`, which is a SEPARATE, hand-written
// declaration from `limits.wallClockMinutes`. Nothing checked that they agree.
// Both issues happen to be consistent today (45min/2700s, 15min/900s) by hand.
// Edit one and forget the other and the declared limit silently stops
// describing the enforced one — with no failing test, no drift, and a run that
// is bounded at a number nobody wrote down.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validate } = require("../../lib/config");
const { FactoryError } = require("../../lib/util");

const REPO = path.resolve(__dirname, "../..");

const baseCfg = (issue) => ({
  version: 1, api: {}, pins: {}, instance: {}, company: {},
  projects: [], agents: [], operator: {},
  issues: [issue],
});

const issue = (over = {}) => ({
  identifier: "ZEI-9",
  limits: { wallClockMinutes: 15 },
  assigneeAdapterOverrides: { adapterConfig: { timeoutSec: 900, maxTime: "15m" } },
  ...over,
});

test("a consistent issue validates", () => {
  assert.doesNotThrow(() => validate(baseCfg(issue())));
});

test("a timeoutSec that disagrees with wallClockMinutes is refused", () => {
  assert.throws(
    () => validate(baseCfg(issue({
      limits: { wallClockMinutes: 15 },
      assigneeAdapterOverrides: { adapterConfig: { timeoutSec: 1800, maxTime: "15m" } },
    }))),
    (err) => {
      assert.ok(err instanceof FactoryError);
      assert.match(err.message, /ZEI-9/);
      assert.match(err.message, /900/, "the required value must be stated, not just the mismatch");
      assert.match(err.message, /1800/);
      return true;
    },
  );
});

test("a maxTime that disagrees with wallClockMinutes is refused", () => {
  assert.throws(
    () => validate(baseCfg(issue({
      assigneeAdapterOverrides: { adapterConfig: { timeoutSec: 900, maxTime: "45m" } },
    }))),
    /maxTime/,
  );
});

test("declaring a wall-clock limit with no override at all is refused", () => {
  // The limit would be documentation. `adapterConfig.timeoutSec` on the AGENT
  // is a shared default across every issue that agent runs; only the issue
  // override can bound one issue.
  assert.throws(
    () => validate(baseCfg(issue({ assigneeAdapterOverrides: undefined }))),
    /assigneeAdapterOverrides/,
  );
});

test("an override with no declared limit is refused — the bound must be stated where it is read", () => {
  assert.throws(
    () => validate(baseCfg(issue({ limits: { costCeilingUsd: 3 } }))),
    /wallClockMinutes/,
  );
});

test("an issue with neither is fine — not every issue declares a wall-clock bound", () => {
  assert.doesNotThrow(() => validate(baseCfg({
    identifier: "ZEI-9", limits: { costCeilingUsd: 3 },
  })));
});

test("a non-integer or non-positive wall-clock limit is refused", () => {
  for (const bad of [0, -5, 1.5, "15"]) {
    assert.throws(
      () => validate(baseCfg(issue({
        limits: { wallClockMinutes: bad },
        assigneeAdapterOverrides: { adapterConfig: { timeoutSec: 900, maxTime: "15m" } },
      }))),
      /wallClockMinutes/,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

// ---- the shipped config must satisfy its own rule -------------------------

test("every issue in the real factory.config.json is internally consistent", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, "factory.config.json"), "utf8"));
  for (const i of raw.issues) {
    const minutes = i.limits?.wallClockMinutes;
    if (minutes === undefined) continue;
    assert.equal(i.assigneeAdapterOverrides?.adapterConfig?.timeoutSec, minutes * 60,
      `${i.identifier}: wallClockMinutes ${minutes} implies timeoutSec ${minutes * 60}`);
    assert.equal(i.assigneeAdapterOverrides?.adapterConfig?.maxTime, `${minutes}m`,
      `${i.identifier}: wallClockMinutes ${minutes} implies maxTime ${minutes}m`);
  }
});
