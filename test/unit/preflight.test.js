"use strict";
// Preflight gates. Every one of these exists because the alternative is a
// dispatch that fails halfway, or worse, one that appears to succeed.
//
// The launch gate is the most load-bearing. Everything that arms an OMP agent
// reaches the CLI through adapterConfig.extraArgs and NOTHING else — the
// adapter and the server both ignore configFiles/hooks/tools/pluginDirs
// entirely. So a config can declare a full boundary, pass every other test, and
// arm nothing. This gate runs the real configured argv and demands proof.

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkAgentLaunch, checkVerifier, summarize } = require("../../lib/preflight");

const REVIEWER_ARGS = [
  "--config", "/repo/omp/reviewer.policy.yml",
  "--extension", "/repo/omp/plugins/paperclip-review",
  "--tools", "read,grep,glob,lsp,todo,paperclip_review",
];
// Reaching model resolution is the pass condition: validation and discovery
// both happened, and no provider was contacted.
const reachedModel = () => ({ status: 1, stdout: "", stderr: `Model "x/y" not found` });

test("the launch gate passes only when OMP really registers the tool", () => {
  const unregistered = checkAgentLaunch({
    agentName: "OMP Reviewer", extraArgs: REVIEWER_ARGS, requireTool: "paperclip_review",
    exec: () => ({
      status: 1, stdout: "",
      stderr: "CliUsageError: Unknown tool in --tools: paperclip_review. Valid tools: read, write.",
    }),
  });
  assert.equal(unregistered.ok, false);
  assert.match(unregistered.detail, /paperclip_review/, "the failure must name the tool");
  assert.match(unregistered.detail, /--extension/,
    "and must point at the real cause, so the next reader does not re-derive it");

  const registered = checkAgentLaunch({
    agentName: "OMP Reviewer", extraArgs: REVIEWER_ARGS, requireTool: "paperclip_review",
    exec: reachedModel,
  });
  assert.equal(registered.ok, true);
});

test("the launch gate fails an agent that arms nothing", () => {
  // The exact shape of the bug this gate was rewritten for: adapterConfig
  // declared configFiles/hooks/tools/pluginDirs, none of which reach OMP.
  const r = checkAgentLaunch({ agentName: "OMP Engineer", extraArgs: [], exec: reachedModel });
  assert.equal(r.ok, false, "no extraArgs means no policy and no hook reach OMP");
  assert.match(r.detail, /extraArgs/);
});

test("the launch gate fails when the required tool is absent from the configured allowlist", () => {
  // --tools is an allowlist and the LAST one wins, so an allowlist that omits
  // the tool disarms the Reviewer even when the plugin is perfectly discoverable.
  const r = checkAgentLaunch({
    agentName: "OMP Reviewer", requireTool: "paperclip_review",
    extraArgs: ["--config", "/repo/omp/reviewer.policy.yml", "--tools", "read,grep"],
    exec: reachedModel,
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /paperclip_review/);
});

test("the launch gate fails on a rejected flag or a malformed strict policy", () => {
  const r = checkAgentLaunch({
    agentName: "OMP Reviewer", extraArgs: REVIEWER_ARGS, requireTool: "paperclip_review",
    exec: () => ({ status: 1, stdout: "", stderr: "CliUsageError: Unknown tool in --tools: ast-grep." }),
  });
  assert.equal(r.ok, false, "a bad flag must fail even when it is not the tool itself");
  assert.match(r.detail, /ast-grep/);
});

test("the launch gate treats an unrunnable or inconclusive probe as a failure, never as a pass", () => {
  const unrunnable = checkAgentLaunch({
    agentName: "OMP Reviewer", extraArgs: REVIEWER_ARGS, requireTool: "paperclip_review",
    exec: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }),
  });
  assert.equal(unrunnable.ok, false, "a probe that could not run proves nothing and must not pass");
  assert.match(unrunnable.detail, /ENOENT|could not/i);

  const inconclusive = checkAgentLaunch({
    agentName: "OMP Reviewer", extraArgs: REVIEWER_ARGS, requireTool: "paperclip_review",
    exec: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.equal(inconclusive.ok, false,
    "silence is not proof of a healthy launch; the probe must reach a known decision point");
});

test("the verifier gate fails when the sandbox is missing or not executable", () => {
  const path = require("node:path");
  const REAL = path.resolve(__dirname, "../../ops/omp-verify-bwrap.sh");

  const ok = checkVerifier({ verifierPath: REAL, exec: () => ({ status: 0, stdout: "", stderr: "" }) });
  assert.equal(ok.ok, true);

  const absent = checkVerifier({ verifierPath: "/no/such/verifier.sh", exec: () => ({ status: 0 }) });
  assert.equal(absent.ok, false, "a verifier that is not on disk cannot be the boundary");

  const noBwrap = checkVerifier({
    verifierPath: REAL,
    exec: () => ({ status: 127, stdout: "", stderr: "verify: bwrap not installed." }),
  });
  assert.equal(noBwrap.ok, false);
  assert.match(noBwrap.detail, /bwrap/);
});

test("preflight fails as a whole if any single gate fails", () => {
  const pass = { name: "a", ok: true, detail: "" };
  const fail = { name: "b", ok: false, detail: "nope" };
  assert.equal(summarize([pass, pass]).ok, true);
  assert.equal(summarize([pass, fail]).ok, false);
  assert.deepEqual(summarize([pass, fail]).failed.map((g) => g.name), ["b"]);
  assert.equal(summarize([]).ok, false, "a preflight that checked nothing has proven nothing");
});
