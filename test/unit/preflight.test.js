"use strict";
// Preflight gates. Every one of these exists because the alternative is a
// dispatch that fails halfway, or worse, one that appears to succeed.
//
// The tool-discovery gate is the newest and the most load-bearing: OMP 18.0.10
// does NOT surface a custom tool to --tools via --plugin-dir (proven by probe,
// both with a bare plugin.json and with .claude-plugin/plugin.json). A Reviewer
// configured with `paperclip_review` in its allowlist and no discoverable tool
// dies at startup with CliUsageError, having burned a dispatch.

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkReviewToolDiscoverable, checkVerifier, summarize } = require("../../lib/preflight");

test("the review-tool gate passes only when OMP really lists the tool", () => {
  const listing = (tools) => () => ({
    status: 1, stdout: "",
    stderr: `CliUsageError: Unknown tool in --tools: paperclip_review. Valid tools: ${tools.join(", ")}.`,
  });

  const missing = checkReviewToolDiscoverable({
    ompPath: "omp", toolName: "paperclip_review", exec: listing(["read", "write"]),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /paperclip_review/, "the failure must name the tool");
  assert.match(missing.detail, /--plugin-dir/, "and must say why, so the next reader does not re-derive it");

  // When the tool IS available, omp gets past argument validation and fails on
  // the deliberately invalid model instead.
  const present = checkReviewToolDiscoverable({
    ompPath: "omp", toolName: "paperclip_review",
    exec: () => ({ status: 1, stdout: "", stderr: "Error: model 'nonexistent/x' not found" }),
  });
  assert.equal(present.ok, true);
});

test("the review-tool gate treats an unrunnable probe as a failure, never as a pass", () => {
  const r = checkReviewToolDiscoverable({
    ompPath: "omp", toolName: "paperclip_review",
    exec: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }),
  });
  assert.equal(r.ok, false, "a probe that could not run proves nothing and must not pass");
  assert.match(r.detail, /ENOENT|could not/i);
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
