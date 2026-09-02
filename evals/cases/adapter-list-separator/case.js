"use strict";
const assert = require("node:assert/strict");
const { stringList, adapterArgv } = require("../../../lib/preflight");

module.exports = {
  run() {
    // Path keys take the DEFAULT (newline) split, so a comma is part of the name.
    assert.deepEqual(stringList("a.yml,b.yml"), ["a.yml,b.yml"],
      "a comma-joined path string is ONE path, exactly as the adapter reads it");
    assert.deepEqual(stringList("a.yml\nb.yml"), ["a.yml", "b.yml"]);

    // tools/skills/modelCycle are the only comma-separated keys.
    assert.deepEqual(stringList("read,write", true), ["read", "write"]);

    // The consequence the incident actually had: the gate must not invent a
    // second --config that the real launch will never receive.
    const argv = adapterArgv({ configFiles: "/r/a.yml,/r/b.yml" });
    assert.equal(argv.filter((a) => a === "--config").length, 1,
      "modelling the launch more generously than the launch is how preflight passed 6/6 " +
      "while dispatch died three times");
    assert.deepEqual(argv, ["--config", "/r/a.yml,/r/b.yml"]);

    // And the correct declaration still produces two.
    assert.equal(
      adapterArgv({ configFiles: ["/r/a.yml", "/r/b.yml"] }).filter((a) => a === "--config").length, 2);
  },
};
