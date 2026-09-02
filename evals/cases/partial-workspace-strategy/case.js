"use strict";
const assert = require("node:assert/strict");
const { validate } = require("../../../lib/config");

const FULL = {
  type: "git_worktree", baseRef: "main",
  branchTemplate: "paperclip/{identifier}",
  worktreeParentDir: "/home/x/.paperclip/worktrees/p",
};
const cfg = (workspaceStrategy) => ({
  version: 1, api: {}, pins: {}, instance: {}, company: {},
  projects: [], agents: [], operator: {},
  issues: [{ identifier: "ZEI-9", executionWorkspaceSettings: { workspaceStrategy } }],
});

module.exports = {
  run() {
    assert.doesNotThrow(() => validate(cfg(FULL)), "a complete strategy is legal");
    // Every field is load-bearing; dropping any one is the failure.
    for (const field of ["baseRef", "branchTemplate", "worktreeParentDir"]) {
      const partial = { ...FULL };
      delete partial[field];
      assert.throws(() => validate(cfg(partial)), new RegExp(field),
        `a strategy missing ${field} must be refused, and the field named`);
    }
    try { const p = { ...FULL }; delete p.branchTemplate; validate(cfg(p)); assert.fail("expected refusal"); }
    catch (err) {
      assert.match(err.message, /ZEI-9/, "name the issue");
      assert.match(err.message, /REPLACES/, "name why partial is not partial-merge");
    }
  },
};
