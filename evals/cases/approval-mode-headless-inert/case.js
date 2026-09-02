"use strict";
const assert = require("node:assert/strict");
const { validate } = require("../../../lib/config");

const cfg = (approvalMode) => ({
  version: 1, api: {}, pins: {}, instance: {}, company: {},
  projects: [], issues: [], operator: {},
  agents: [{
    name: "OMP Engineer", role: "engineer", adapterType: "omp_local",
    adapterConfig: { approvalMode },
  }],
});

module.exports = {
  run() {
    // The exact 2026-08-31 configuration must be refused.
    assert.throws(() => validate(cfg("write")), /approvalMode/,
      "approvalMode: write is the ZEI-1 runaway configuration");
    // always-ask is the same failure with a different label.
    assert.throws(() => validate(cfg("always-ask")), /approvalMode/);
    // The error has to be actionable, not merely negative.
    try { validate(cfg("write")); assert.fail("expected a refusal"); }
    catch (err) {
      assert.match(err.message, /OMP Engineer/, "name the agent");
      assert.match(err.message, /exits 0/, "name the mechanism, not just the rule");
      assert.match(err.message, /yolo/, "state the fix");
    }
    // The containment posture must still be expressible.
    assert.doesNotThrow(() => validate(cfg("yolo")));
    // A non-OMP agent is out of scope: it may have a UI.
    assert.doesNotThrow(() => validate({
      ...cfg("yolo"),
      agents: [{ name: "Hermes", adapterType: "hermes_local", adapterConfig: { approvalMode: "write" } }],
    }));
  },
};
