"use strict";
// `factory preflight <issue>` — every gate that must hold before a dispatch.
//
// A gate here exists because something can be true at config time and false at
// dispatch time. The config declares intent; these check reality. All of them
// fail closed: a check that could not run has proven nothing, and proving
// nothing is a failure, not a pass.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const gate = (name, ok, detail = "") => ({ name, ok, detail });

/**
 * Is the Reviewer's one write-capable tool actually reachable by OMP?
 *
 * WHY THIS GATE EXISTS. OMP 18.0.10 does NOT surface a custom tool to `--tools`
 * through `--plugin-dir`. Probed directly, with the plugin directory laid out
 * both as <dir>/tools/<name>/index.ts + plugin.json and as the Claude-plugin
 * shape with .claude-plugin/plugin.json, the result is the same:
 *
 *   CliUsageError: Unknown tool in --tools: paperclip_review.
 *   Valid tools: read, write, goal, ...
 *
 * That error is fatal at STARTUP, before the model is reached. So a Reviewer
 * agent configured with `paperclip_review` in its allowlist and no discoverable
 * tool does not review badly — it never runs, having consumed a dispatch and a
 * review round. The failure is loud but late, and it lands mid-flow.
 *
 * The probe deliberately uses an invalid model: OMP validates `--tools` BEFORE
 * resolving the model, so reaching a model error means argument validation
 * passed, which is exactly the fact this gate needs. No model is contacted and
 * nothing is billed.
 */
function checkReviewToolDiscoverable({ ompPath = "omp", toolName = "paperclip_review", args = [], exec = spawnSync }) {
  const r = exec(ompPath, [
    ...args,
    "--tools", `read,${toolName}`,
    "--model", "factory-preflight/deliberately-invalid",
    "-p", "preflight",
  ], { encoding: "utf8", timeout: 120000 });

  if (r?.error || (r?.status === null && !r?.stderr)) {
    return gate("review tool discoverable", false,
      `could not run the discovery probe (${r?.error?.message ?? "no result"}); ` +
      `a probe that did not run proves nothing`);
  }
  const out = `${r?.stdout ?? ""}${r?.stderr ?? ""}`;
  if (new RegExp(`Unknown tool in --tools: ${toolName}`).test(out)) {
    return gate("review tool discoverable", false,
      `OMP does not expose ${toolName}. Note that --plugin-dir does NOT register custom tools in ` +
      `OMP 18.0.10 — this was probed directly. Until a discovery path is proven, the Reviewer ` +
      `agent cannot start and dispatch must not proceed.`);
  }
  return gate("review tool discoverable", true, `${toolName} passed OMP argument validation`);
}

/** The read-only verifier must exist and refuse to run without bwrap. */
function checkVerifier({ verifierPath, exec = spawnSync }) {
  if (!fs.existsSync(verifierPath)) {
    return gate("read-only verifier", false, `${verifierPath} does not exist`);
  }
  const r = exec("bash", [verifierPath, "--worktree", path.dirname(verifierPath), "--", "true"],
    { encoding: "utf8", timeout: 60000 });
  const out = `${r?.stdout ?? ""}${r?.stderr ?? ""}`;
  if (r?.status === 127 || /bwrap not installed/.test(out)) {
    return gate("read-only verifier", false,
      "bwrap is not installed; the sandbox is the boundary and the verifier refuses to run without it");
  }
  if (r?.error) return gate("read-only verifier", false, `verifier probe failed: ${r.error.message}`);
  return gate("read-only verifier", true, verifierPath);
}

/** A preflight that checked nothing has proven nothing. */
function summarize(gates) {
  const failed = gates.filter((g) => !g.ok);
  return { ok: gates.length > 0 && failed.length === 0, gates, failed };
}

async function run(cfg, args, { connect, requireHealthy, C }) {
  const identifier = args._[1];
  if (!identifier) {
    console.error(C.red("preflight requires an issue identifier, e.g. factory preflight ZEI-1"));
    return 2;
  }
  const issue = cfg.issues.find((i) => i.identifier === identifier);
  if (!issue) {
    console.error(C.red(`no issue ${identifier} is declared in ${path.basename(cfg._file)}`));
    return 2;
  }

  const gates = [
    checkVerifier({ verifierPath: path.join(cfg._root, "ops/omp-verify-bwrap.sh") }),
    checkReviewToolDiscoverable({}),
  ];

  // Live gates only when the instance is reachable; an unreachable control plane
  // is itself a failed preflight rather than a skipped one.
  try {
    const api = connect(cfg);
    await requireHealthy(api);
    gates.push(gate("paperclip healthy", true, api.baseUrl));
  } catch (err) {
    gates.push(gate("paperclip healthy", false, err.message));
  }

  const summary = summarize(gates);
  for (const g of summary.gates) {
    console.log(`  ${g.ok ? C.green("ok  ") : C.red("FAIL")} ${g.name}${g.detail ? C.dim(`  ${g.detail}`) : ""}`);
  }
  console.log(summary.ok
    ? C.green(`\npreflight passed for ${identifier}`)
    : C.red(`\npreflight FAILED for ${identifier} — ${summary.failed.length} gate(s). Dispatch is blocked.`));
  return summary.ok ? 0 : 1;
}

module.exports = { checkReviewToolDiscoverable, checkVerifier, summarize, run, gate };
