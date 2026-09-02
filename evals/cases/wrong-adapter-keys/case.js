"use strict";
const assert = require("node:assert/strict");
const { adapterArgv } = require("../../../lib/preflight");

module.exports = {
  run() {
    const argv = adapterArgv({
      tools: "read,paperclip_review",
      skills: "a,b",
      approvalMode: "yolo",
      configFiles: ["/r/omp/base.overlay.yml", "/r/omp/engineer.policy.yml"],
      extensions: ["/r/omp/plugins/paperclip-goal-guard"],
      pluginDirs: ["/r/omp/plugins"],
      hooks: ["/r/omp/worktree-guard.js"],
      extraArgs: ["--last"],
    });
    const at = (flag) => argv.indexOf(flag);

    // Each boundary key must arm its own flag. If any of these is absent the
    // agent runs unpoliced while the config looks complete.
    assert.deepEqual(argv.slice(at("--tools"), at("--tools") + 2),
      ["--tools", "read,paperclip_review"]);
    assert.ok(at("--approval-mode") > -1 && argv[at("--approval-mode") + 1] === "yolo");
    assert.equal(argv.filter((a) => a === "--config").length, 2, "one --config per overlay");
    assert.ok(argv.includes("/r/omp/engineer.policy.yml"), "the policy overlay must reach the CLI");
    assert.ok(at("--extension") > -1 && argv.includes("/r/omp/plugins/paperclip-goal-guard"));
    assert.ok(at("--plugin-dir") > -1);
    assert.ok(at("--hook") > -1 && argv.includes("/r/omp/worktree-guard.js"));

    // extraArgs is appended LAST, matching the adapter (execute.js:215).
    assert.equal(argv[argv.length - 1], "--last");

    // The corrected belief, stated as an assertion: first-class keys are NOT
    // inert, so an empty extraArgs must not mean an empty boundary.
    const noExtra = adapterArgv({ tools: "read", configFiles: ["/r/p.yml"] });
    assert.ok(noExtra.includes("--tools") && noExtra.includes("--config"),
      "a config with no extraArgs still arms its boundary");
  },
};
