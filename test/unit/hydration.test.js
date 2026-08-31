"use strict";
// Config hydration: the committed contracts and instruction bundles must bind
// to the declarative config at LOAD time, fail-closed, before any plan exists.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { load } = require("../../lib/config");
const { hydrateDeclaredContracts } = require("../../lib/contracts");
const { hashText, FactoryError } = require("../../lib/util");

const ROOT = path.resolve(__dirname, "../..");

test("config load binds each declared agent to the exact compiled bundle bytes via the committed manifest", () => {
  const cfg = load();
  for (const [name, role] of [["OMP Engineer", "engineer"], ["OMP Reviewer", "reviewer"]]) {
    const agent = cfg.agents.find((a) => a.name === name);
    assert.ok(agent?.instructions, `${name} must declare an instructions binding`);
    const declared = agent.instructions;
    assert.equal(declared.path, "AGENTS.md");
    const file = path.join(ROOT, "instructions/out", `AGENTS.${role}.md`);
    assert.equal(declared.content, fs.readFileSync(file, "utf8"),
      `${name} must be bound to the committed generated bundle`);
    assert.equal(declared.sha256, hashText(declared.content),
      `${name} sha256 must be the manifest hash of the bundle bytes`);
  }
});

test("config load binds the ZEI-1 objective document to the verified ObjectiveEnvelopeV1 contract", () => {
  const cfg = load();
  const doc = cfg.issues.find((i) => i.identifier === "ZEI-1").objectiveDocument;
  assert.ok(doc, "ZEI-1 must declare an objectiveDocument");
  assert.equal(doc.key, "spec");
  assert.equal(doc.format, "markdown");
  assert.ok(doc.title.includes("ZEI-1"));
  // The rendered body must carry the envelope's own hashes, so the document on
  // the issue is self-verifying against the committed contract.
  assert.match(doc.body, new RegExp(doc.objective.objectiveHash.slice("sha256:".length)));
  assert.match(doc.body, new RegExp(doc.objective.criteriaHash.slice("sha256:".length)));
  assert.equal(doc.bodyHash, hashText(doc.body));
  assert.equal(doc.objective.repository.baseCommit, "3cb8238");
  assert.equal(doc.objective.limits.wallClockMinutes, 45);
  assert.equal(doc.objective.limits.costCeilingUsd, 4);
});

test("hydration fails closed when the manifest does not match the compiled bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-hydrate-"));
  fs.mkdirSync(path.join(root, "instructions/out"), { recursive: true });
  fs.writeFileSync(path.join(root, "instructions/out/AGENTS.engineer.md"), "bundle bytes\n");
  fs.writeFileSync(path.join(root, "instructions/manifest.sha256"),
    `${"0".repeat(64)}  out/AGENTS.engineer.md\n`);
  const cfg = { agents: [{ name: "OMP Engineer", instructions: { path: "AGENTS.md", bundle: "engineer" } }] };
  assert.throws(() => hydrateDeclaredContracts(cfg, root), (err) => {
    assert.ok(err instanceof FactoryError);
    assert.match(err.message, /manifest/);
    return true;
  });
});

test("hydration fails closed when the declared bundle is absent from the manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-hydrate-"));
  fs.mkdirSync(path.join(root, "instructions/out"), { recursive: true });
  fs.writeFileSync(path.join(root, "instructions/out/AGENTS.reviewer.md"), "bundle bytes\n");
  fs.writeFileSync(path.join(root, "instructions/manifest.sha256"),
    `${hashText("bundle bytes\n").slice("sha256:".length)}  out/AGENTS.engineer.md\n`);
  const cfg = { agents: [{ name: "OMP Reviewer", instructions: { path: "AGENTS.md", bundle: "reviewer" } }] };
  assert.throws(() => hydrateDeclaredContracts(cfg, root), /manifest/);
});

test("hydration rejects an objective whose issueIdentifier does not match the declaring issue", () => {
  const cfg = {
    issues: [{
      identifier: "ZEI-2",
      objectiveDocument: {
        key: "spec", title: "wrong issue", format: "markdown",
        sourceFile: path.join(ROOT, "contracts/objectives/ZEI-1.json"),
        changeSummary: "x",
      },
    }],
  };
  assert.throws(() => hydrateDeclaredContracts(cfg, ROOT), /belongs to ZEI-1/);
});
