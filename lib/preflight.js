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
const { Resolver } = require("./resolve");
const { resolveObjectiveForIssue } = require("./objective");

const gate = (name, ok, detail = "") => ({ name, ok, detail });

/**
 * Will this agent's REAL configured launch actually start?
 *
 * WHY THIS GATE EXISTS. A config can declare a complete boundary — policy
 * overlay, worktree hook, tool allowlist, custom-tool extension — and pass every
 * unit test while arming nothing, because whether a key reaches the CLI depends
 * entirely on the adapter. The only symptom is a Reviewer that dies at startup,
 * or worse, an Engineer that runs unpoliced and looks fine.
 *
 * CORRECTED 2026-09-01: this gate previously required `extraArgs` and declared
 * every other key "silently ignored". That was measured against
 * @paperclipai/adapter-pi-local, which serves `pi` — a different product from
 * Oh My Pi. These agents run on @zhafron/paperclip-omp-adapter, which builds
 * argv from FIRST-CLASS keys and appends extraArgs last. The old gate therefore
 * failed a correct config and would have passed a config that armed nothing
 * through the keys the adapter actually reads.
 *
 * So this gate does not ask whether a mechanism exists in the abstract. It
 * rebuilds the argv the way the adapter does (see adapterArgv) and runs OMP with
 * it. Three outcomes matter:
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
/**
 * Rebuild the OMP argv exactly as @zhafron/paperclip-omp-adapter does, so the
 * probe below proves the launch the dispatch will really perform.
 *
 * Order and flag names mirror dist/server/execute.js: tools :153, skills :155,
 * approval-mode :157, config :188, extension :190, plugin-dir :192, hook :194,
 * then extraArgs appended verbatim LAST (:215). `model` is deliberately omitted
 * — the caller supplies an invalid one so the probe stops before any provider
 * call. A value may be a string or an array; the adapter accepts both.
 */
/**
 * The adapter's own list splitter, reproduced exactly.
 *
 * dist/server/execute.js:31
 *   stringList(value, commaSeparated = false)
 *     value.split(commaSeparated ? /[\r\n,]+/ : /\r?\n/)
 *
 * THE DEFAULT IS NEWLINE, AND THE DEFAULT IS WHAT PATH KEYS GET. Only
 * modelCycle (:131), tools (:132) and skills (:133) are called with `true`.
 * configFiles (:187), extensions (:189), pluginDirs (:191) and hooks (:193)
 * take the default, so for them a comma is an ordinary filename character
 * and "a.yml,b.yml" is ONE path.
 *
 * This function used to split everything on commas. It was more forgiving
 * than the adapter, so the launch probe passed while the real dispatch could
 * not start: the first live canary failed three times on
 * `Config overlay not found: /…/base.overlay.yml,/…/engineer.policy.yml`
 * against a preflight that had just reported 6/6. A gate that stands in for
 * the real launch must never model it more generously than the real thing.
 */
function stringList(value, commaSeparated = false) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(commaSeparated ? /[\r\n,]+/ : /\r?\n/)
      : [];
  return values.filter((e) => typeof e === "string").map((e) => e.trim()).filter(Boolean);
}

function adapterArgv(adapterConfig = {}) {
  const args = [];
  const tools = stringList(adapterConfig.tools, true);
  if (tools.length) args.push("--tools", tools.join(","));
  const skills = stringList(adapterConfig.skills, true);
  if (skills.length) args.push("--skills", skills.join(","));
  const approval = String(adapterConfig.approvalMode ?? "").trim();
  if (["always-ask", "write", "yolo"].includes(approval)) args.push("--approval-mode", approval);
  for (const f of stringList(adapterConfig.configFiles)) args.push("--config", f);
  for (const e of stringList(adapterConfig.extensions)) args.push("--extension", e);
  for (const d of stringList(adapterConfig.pluginDirs)) args.push("--plugin-dir", d);
  for (const h of stringList(adapterConfig.hooks)) args.push("--hook", h);
  for (const a of adapterConfig.extraArgs ?? []) args.push(a);
  return args;
}

// Fixed literal prompt so the rebuilt Hermes argv is deterministic. The
// adapter renders a real wake-up prompt at dispatch time; preflight proves
// the FLAGS, and they are independent of the prompt text.
const HERMES_PREFLIGHT_PROMPT = "factory preflight: launch configuration probe";

/**
 * Rebuild the Hermes argv exactly as @paperclipai/hermes-paperclip-adapter
 * does (dist/server/execute.js:337-377), so the probe below proves the launch
 * the dispatch will really perform: `chat -q <prompt>`, then -Q when quiet,
 * -m when a model is set, --provider when set and not "auto" (the adapter
 * likewise passes none for "auto"), -t for toolsets (the enabledToolsets
 * array alias is joined, as the adapter does), --max-turns when
 * maxTurnsPerRun > 0, -w, --checkpoints, -v, then the fixed --source tool
 * --yolo tail. No --resume: there is no prior session at preflight time.
 * extraArgs is appended verbatim LAST, exactly as the adapter does.
 */
function hermesArgv(adapterConfig = {}) {
  const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);
  const num = (v) => (typeof v === "number" ? v : null);
  const toolsets = str(adapterConfig.toolsets)
    ?? (Array.isArray(adapterConfig.enabledToolsets) && adapterConfig.enabledToolsets.length
      ? adapterConfig.enabledToolsets.join(",") : null);
  const args = ["chat", "-q", HERMES_PREFLIGHT_PROMPT];
  if (adapterConfig.quiet === true) args.push("-Q");
  const model = str(adapterConfig.model);
  if (model) args.push("-m", model);
  const provider = str(adapterConfig.provider);
  if (provider && provider !== "auto") args.push("--provider", provider);
  if (toolsets) args.push("-t", toolsets);
  const maxTurns = num(adapterConfig.maxTurnsPerRun);
  if (maxTurns && maxTurns > 0) args.push("--max-turns", String(maxTurns));
  if (adapterConfig.worktreeMode === true) args.push("-w");
  if (adapterConfig.checkpoints === true) args.push("--checkpoints");
  if (adapterConfig.verbose === true) args.push("-v");
  args.push("--source", "tool");
  args.push("--yolo");
  for (const a of adapterConfig.extraArgs ?? []) args.push(a);
  return args;
}

function checkAgentLaunch({
  agentName,
  adapterConfig = null,
  extraArgs = [],
  requireTool = null,
  ompPath = "omp",
  exec = spawnSync,
}) {
  const name = `${agentName} launches as configured`;
  const cfg = adapterConfig ?? { extraArgs };
  const argv = adapterArgv(cfg);

  if (argv.length === 0) {
    return gate(name, false,
      `no policy, hook, tool or extension is configured, so nothing reaches OMP ` +
      `and this agent would launch with the CLI's own defaults`);
  }
  if (requireTool && !argv.some((a) => typeof a === "string" && a.split(",").includes(requireTool))) {
    return gate(name, false,
      `${requireTool} is not present in the configured --tools list, so the agent ` +
      `would start without its one write-capable tool`);
  }

  const r = exec(ompPath, [
    ...argv,
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

/**
 * Will the Hermes agent's REAL configured launch actually start?
 *
 * Same fail-closed contract as checkAgentLaunch, but the Hermes adapter
 * builds argv differently (see hermesArgv). The probe must never reach a
 * model: it runs `hermes chat --help` — pure argument parsing, no provider
 * call, nothing billed — and demands that the installed CLI ADVERTISE every
 * flag the configured argv would emit. That is what makes this a
 * configuration probe rather than an existence check: a flag the installed
 * hermes does not know (a renamed or version-skewed option) fails here
 * instead of the dispatch dying at argument parsing.
 *
 * Fails on ENOENT, a non-zero exit, inconclusive output, and any emitted
 * flag the help text does not advertise.
 */
function checkHermesLaunch({
  agentName,
  adapterConfig = {},
  hermesPath = null,
  exec = spawnSync,
}) {
  const name = `${agentName} launches as configured`;
  const argv = hermesArgv(adapterConfig);
  // resolveHermesCommand: hermesCommand, then command, then "hermes".
  const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);
  const cmd = hermesPath ?? str(adapterConfig.hermesCommand)
    ?? str(adapterConfig.command) ?? "hermes";

  const r = exec(cmd, ["chat", "--help"], { encoding: "utf8", timeout: 60000 });

  if (r?.error || (r?.status === null && !r?.stderr)) {
    return gate(name, false,
      `could not run the launch probe (${r?.error?.message ?? "no result"}); ` +
      `a probe that did not run proves nothing`);
  }
  if (r.status !== 0) {
    return gate(name, false,
      `\`${cmd} chat --help\` exited ${r.status}; the probe itself failed, so ` +
      `nothing about the configured launch is proven`);
  }
  const out = `${r?.stdout ?? ""}${r?.stderr ?? ""}`;
  if (!out.trim() || !/^usage:.*\bchat\b/m.test(out)) {
    return gate(name, false,
      `the probe output was inconclusive; help text that does not document the ` +
      `chat subcommand proves nothing. Output began: ${out.trim().slice(0, 200)}`);
  }

  const advertised = (flag) => {
    const re = new RegExp(`(^|[\\s,\\[(-])${flag}([\\s,\\]]|$)`);
    return re.test(out);
  };
  // Only flag-SHAPED tokens: an extraArgs value can legitimately start with
  // "-" (e.g. the stdin sentinel `--query-file -`) and is not a flag.
  const flags = [...new Set(argv.filter((x) => /^--?[a-zA-Z]/.test(x)))];
  const missing = flags.filter((f) => !advertised(f));
  if (missing.length) {
    return gate(name, false,
      `the installed ${cmd} does not advertise ${missing.join(", ")}, but the ` +
      `configured launch emits ${flags.join(", ")} — the dispatch would die at ` +
      `argument parsing`);
  }
  return gate(name, true,
    `help advertises every configured flag (${flags.join(", ")})`);
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

/**
 * The Reviewer must be mechanically unable to spawn paid subagent tasks.
 *
 * Two independent layers deny `task`, and neither may be the only one:
 *   - the adapterConfig tools allowlist (--tools): `task` absent, so the CLI
 *     never registers it;
 *   - the strict --config policy overlay: tools.approval.task: deny, so even
 *     a tool that somehow re-registers is refused.
 * A hand-edited live agent record, an apply regression, or an adapter default
 * could each restore a tool one layer withholds; the other must still hold.
 */
function checkReviewerDenial({
  agent,
  policyPath,
  readFileSync = fs.readFileSync,
  buildArgv = adapterArgv,
}) {
  const name = "reviewer cannot spawn subagent tasks";
  if (!agent) return gate(name, false, "no reviewer agent is declared");
  const cfg = agent.adapterConfig ?? {};
  const list = (v) => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [v] : [])
    .flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);
  const tools = [...list(cfg.tools)];
  // The allowlist may also ride in extraArgs as a --tools pair; every
  // declaration must withhold task, not just the first-class key.
  const argv = buildArgv(cfg);
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--tools") {
      tools.push(...String(argv[i + 1] ?? "").split(",").map((x) => x.trim()).filter(Boolean));
    }
  }
  if (tools.includes("task")) {
    return gate(name, false,
      `task is present in a configured --tools declaration; the Reviewer would ` +
      `launch able to spawn paid fan-outs`);
  }

  let content;
  try {
    content = readFileSync(policyPath, "utf8");
  } catch (err) {
    return gate(name, false, `the policy overlay is unreadable (${err.message})`);
  }
  const toolsBlock = content.match(/^tools:\n((?:[ \t][^\n]*\n?)*)/m)?.[1] ?? "";
  const approvalBlock = toolsBlock.match(/^[ \t]+approval:\n((?:[ \t]{2,}[^\n]*\n?)*)/m)?.[1] ?? "";
  if (!/^[ \t]*task:[ \t]*deny\b/m.test(approvalBlock)) {
    return gate(name, false,
      `${policyPath} does not carry tools.approval.task: deny; the --tools ` +
      `allowlist would be the only thing withholding the tool`);
  }
  return gate(name, true, `task withheld by the --tools allowlist and by ${policyPath}`);
}

/**
 * The objective of an issue no config declares must resolve from its own spec
 * document. Fail-closed like every other gate: an objective that could not be
 * fetched, parsed, hash-verified, or bound to this identifier has proven
 * nothing, and dispatching would wake an Engineer against no objective at all.
 */
async function undeclaredObjectiveGate({ cfg, identifier, connect }) {
  const name = `${identifier} objective resolves from its spec document`;
  try {
    const api = connect(cfg);
    const resolver = new Resolver(api);
    const company = await resolver.company(cfg.company.name);
    const issue = await resolver.issue(company.id, identifier);
    const objective = await resolveObjectiveForIssue({ api, issueId: issue.id, identifier });
    return gate(name, true,
      `${objective.objectiveId} rev ${objective.revision}, ` +
      `${objective.acceptanceCriteria.length} acceptance criterion(a)`);
  } catch (err) {
    return gate(name, false, err.message);
  }
}

/** A preflight that checked nothing has proven nothing. */
function summarize(gates) {
  const failed = gates.filter((g) => !g.ok);
  return { ok: gates.length > 0 && failed.length === 0, gates, failed };
}

/**
 * Probe one agent's launch through its OWN adapter. Routing is by
 * adapterType, never by role name: an omp_local agent must not be probed
 * with Hermes argv and vice versa, and an unknown adapterType fails closed
 * because probing it with either argv would prove nothing about its real
 * launch.
 */
function agentLaunchGate(agent, { requireTool = null, exec = spawnSync } = {}) {
  if (agent.adapterType === "hermes_local") {
    if (requireTool) {
      return gate(`${agent.name} launches as configured`, false,
        `tool-availability probing is not implemented for hermes_local; the ` +
        `role that requires ${requireTool} must run omp_local`);
    }
    return checkHermesLaunch({
      agentName: agent.name, adapterConfig: agent.adapterConfig ?? {}, exec,
    });
  }
  if (agent.adapterType !== "omp_local") {
    return gate(`${agent.name} launches as configured`, false,
      `unknown adapterType "${agent.adapterType ?? "<missing>"}"; no launch ` +
      `probe exists for it and a hypothetical probe would prove nothing`);
  }
  return checkAgentLaunch({
    agentName: agent.name,
    adapterConfig: agent.adapterConfig ?? {},
    requireTool,
    exec,
  });
}

async function run(cfg, args, { connect, requireHealthy, C, exec = spawnSync }) {
  const identifier = args._[1];
  if (!identifier) {
    console.error(C.red("preflight requires an issue identifier, e.g. factory preflight ZEI-1"));
    return 2;
  }
  // AN UNDECLARED ISSUE IS NORMAL, NOT AN ERROR.
  //
  // This used to refuse any identifier absent from factory.config.json, which
  // made every Hermes-created child unpreflightable — for no reason connected
  // to what preflight checks. Every gate below is AGENT-level: the verifier,
  // the two launch probes, the reviewer denial, the Hermes probe, the health
  // check. None of them reads the issue.
  //
  // The identifier still has to mean something, so an undeclared one is proved
  // the only way it can be: its objective must resolve from its own spec
  // document. That is also the one genuinely issue-specific fact preflight can
  // establish, and it is exactly what a half-completed handoff leaves broken.
  const declared = cfg.issues.find((i) => i.identifier === identifier) ?? null;

  // Probe each agent with the arguments this issue's dispatch will really use.
  // A gate that checks a hypothetical launch proves nothing about this one.
  const agentGate = (role, requireTool) => {
    const agent = cfg.agents.find((a) => a.role === role);
    if (!agent) return gate(`${role} launches as configured`, false, `no ${role} agent is declared`);
    return agentLaunchGate(agent, { requireTool, exec });
  };

  const gates = [
    checkVerifier({ verifierPath: path.join(cfg._root, "ops/omp-verify-bwrap.sh"), exec }),
    agentGate("reviewer", "paperclip_review"),
    agentGate("engineer", null),
    checkReviewerDenial({
      agent: cfg.agents.find((a) => a.role === "reviewer"),
      policyPath: path.join(cfg._root, "omp/reviewer.policy.yml"),
    }),
  ];

  // For an undeclared issue, prove the objective exists and self-verifies.
  // Declared issues already have theirs checked at config-load time
  // (lib/contracts.js hydrateDeclaredContracts), so re-fetching would only
  // re-prove what the config gate proved, and would fail preflight whenever
  // the instance is down for a reason the health gate already reports.
  if (!declared) {
    gates.push(await undeclaredObjectiveGate({ cfg, identifier, connect }));
  }

  // The Hermes (generalist) gate is SKIPPED while no generalist agent is
  // declared — preflight must keep passing before the Hermes agent lands in
  // the config. Once declared, the gate runs and can fail the summary, routed
  // by adapterType like every other launch gate.
  const generalist = cfg.agents.find((a) => a.role === "generalist");
  if (generalist) gates.push(agentLaunchGate(generalist, { exec }));

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

module.exports = {
  checkAgentLaunch, adapterArgv, checkHermesLaunch, hermesArgv, HERMES_PREFLIGHT_PROMPT,
  checkVerifier, checkReviewerDenial, agentLaunchGate, undeclaredObjectiveGate, summarize, run, gate,
  stringList,
};
