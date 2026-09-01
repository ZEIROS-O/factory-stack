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
 * Will this agent's REAL configured launch actually start?
 *
 * WHY THIS GATE EXISTS. Everything that arms an OMP agent — the policy overlay,
 * the worktree hook, the tool allowlist, the custom-tool extension — reaches the
 * CLI through one adapterConfig key, `extraArgs`. Every other key
 * (`configFiles`, `hooks`, `tools`, `pluginDirs`, `approvalMode`, `autoApprove`)
 * is silently ignored by both adapter and server. A config can therefore declare
 * a complete boundary and pass every unit test while arming nothing at all, and
 * the only symptom is a Reviewer that dies at startup — or worse, an Engineer
 * that runs unpoliced and looks fine.
 *
 * So this gate does not ask whether a mechanism exists in the abstract. It takes
 * the exact `extraArgs` the dispatch will use and runs OMP with them. Three
 * outcomes matter:
 *
 *   - `Unknown tool in --tools: <name>`  the tool did not register. Note this is
 *     ALWAYS a real discovery miss: OMP validates `--tools` only AFTER session
 *     tool discovery (cli/flag-tables.ts:191), never before.
 *   - any other CliUsageError         a bad flag, or a malformed `--config`
 *     overlay, which is strict and fails closed at startup.
 *   - the model error                 argument validation and discovery both
 *     passed. This is the pass condition.
 *
 * The probe deliberately names an invalid model, so it reaches that decision
 * point without contacting a provider. Nothing is billed.
 *
 * It runs the OMP binary directly rather than through ops/omp-bwrap.sh, because
 * the wrapper needs a dispatched workspace that does not exist at preflight
 * time. The wrapper adds no flags of its own — it execs `bwrap ... -- omp "$@"`
 * — so the argv proven here is the argv it will pass through. Sandboxing is a
 * separate claim, proven by the verifier gate and the bwrap integration tests.
 */
function checkAgentLaunch({
  agentName,
  extraArgs = [],
  requireTool = null,
  ompPath = "omp",
  exec = spawnSync,
}) {
  const name = `${agentName} launches as configured`;

  if (extraArgs.length === 0) {
    return gate(name, false,
      `no extraArgs are configured, so no policy, hook or tool reaches OMP. ` +
      `adapterConfig keys other than extraArgs are silently ignored.`);
  }
  if (requireTool && !extraArgs.some((a) => typeof a === "string" && a.split(",").includes(requireTool))) {
    return gate(name, false,
      `${requireTool} is not present in the configured --tools list, so the agent ` +
      `would start without its one write-capable tool`);
  }

  const r = exec(ompPath, [
    ...extraArgs,
    "--model", "factory-preflight/deliberately-invalid",
    "-p", "preflight",
  ], { encoding: "utf8", timeout: 120000 });

  if (r?.error || (r?.status === null && !r?.stderr)) {
    return gate(name, false,
      `could not run the launch probe (${r?.error?.message ?? "no result"}); ` +
      `a probe that did not run proves nothing`);
  }

  const out = `${r?.stdout ?? ""}${r?.stderr ?? ""}`;

  if (requireTool && new RegExp(`Unknown tool in --tools: ${requireTool}`).test(out)) {
    return gate(name, false,
      `OMP did not register ${requireTool}. Discovery runs BEFORE --tools validation, so this is a ` +
      `real miss, not an ordering artefact. Check that --extension names the plugin root (the nested ` +
      `tools/<name>/index.ts layout is invisible to --plugin-dir), and that the tool module loads — ` +
      `anything that throws while loading it makes OMP drop the tool silently.`);
  }
  if (/CliUsageError/.test(out)) {
    const first = out.match(/CliUsageError:[^\n]*/)?.[0] ?? "CliUsageError";
    return gate(name, false, `OMP rejected the configured arguments — ${first}`);
  }
  if (!/not found|API key/i.test(out)) {
    return gate(name, false,
      `the probe neither failed validation nor reached model resolution, so it proved nothing. ` +
      `Output began: ${out.trim().slice(0, 200)}`);
  }

  return gate(name, true,
    requireTool
      ? `${requireTool} registered; policy and flags accepted`
      : `policy and flags accepted`);
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

  // Probe each agent with the arguments this issue's dispatch will really use.
  // A gate that checks a hypothetical launch proves nothing about this one.
  const agentGate = (role, requireTool) => {
    const agent = cfg.agents.find((a) => a.role === role);
    if (!agent) return gate(`${role} launches as configured`, false, `no ${role} agent is declared`);
    return checkAgentLaunch({
      agentName: agent.name,
      extraArgs: agent.adapterConfig?.extraArgs ?? [],
      requireTool,
    });
  };

  const gates = [
    checkVerifier({ verifierPath: path.join(cfg._root, "ops/omp-verify-bwrap.sh") }),
    agentGate("reviewer", "paperclip_review"),
    agentGate("engineer", null),
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

module.exports = { checkAgentLaunch, checkVerifier, summarize, run, gate };
