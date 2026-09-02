"use strict";
const assert = require("node:assert/strict");
const { classifyRun } = require("../../../lib/failure-class");

module.exports = {
  run() {
    const c = classifyRun({
      runId: "r", status: "succeeded", livenessState: null, nextAction: null,
      usageJson: { costUsd: 3.789 },
    });
    assert.equal(c.class, "reasoning");
    assert.equal(c.autoReplaySafe, false,
      "replaying a reasoning run re-pays for the reasoning — the engine of both cost incidents");
    assert.equal(c.costUsd, 3.789, "the cost of the thing that would be repeated must be visible");

    // A run that DID leave a disposition is productive and needs no intervention.
    assert.equal(classifyRun({
      status: "succeeded", livenessState: "advanced", usageJson: { costUsd: 1 },
    }).class, "productive");

    // An unrecognised failure code must fall to the expensive assumption, never
    // to transport: guessing "cheap to retry" authorises replaying a run that
    // may already have paid a provider.
    const unknown = classifyRun({ status: "failed", errorCode: "something_new", usageJson: {} });
    assert.equal(unknown.class, "reasoning");
    assert.equal(unknown.autoReplaySafe, false);
  },
};
