"use strict";
// Preflight gates. Every one of these exists because the alternative is a
// dispatch that fails halfway, or worse, one that appears to succeed.
//
// The launch gate is the most load-bearing. Everything that arms an OMP agent
// reaches the CLI through the adapter's FIRST-CLASS keys (tools, skills,
// approvalMode, configFiles, extensions, pluginDirs, hooks) with extraArgs
// appended last — @zhafron/paperclip-omp-adapter reads them all and turns
// each into a real CLI flag. So a config can declare a full boundary, pass
// every other test, and arm nothing. This gate rebuilds the real configured
// argv and demands proof. The Hermes gate holds the Hermes adapter to the
// same standard, via `hermes chat --help`; the denial gate proves the
// Reviewer's task denial reaches the real OMP CLI through two layers.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const {
  checkAgentLaunch, checkVerifier, checkHermesLaunch, checkReviewerDenial,
  agentLaunchGate, summarize, adapterArgv, run,
} = require("../../lib/preflight");

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

test("the probe argv mirrors how the OMP adapter builds it from first-class keys", () => {
  // @zhafron/paperclip-omp-adapter execute.js: configFiles->--config :188,
  // extensions->--extension :190, pluginDirs->--plugin-dir :192, hooks->--hook
  // :194, tools->--tools :153, skills->--skills :155, approvalMode :157,
  // extraArgs appended last :215. A probe that reads only extraArgs proves
  // nothing about a config that (correctly) uses the first-class keys.
  const argv = adapterArgv({
    configFiles: "/repo/omp/reviewer.policy.yml",
    extensions: "/repo/omp/plugins/paperclip-review",
    tools: "read,grep,paperclip_review",
    approvalMode: "yolo",
    extraArgs: ["--no-pty"],
  });

  assert.deepEqual(argv, [
    "--tools", "read,grep,paperclip_review",
    "--approval-mode", "yolo",
    "--config", "/repo/omp/reviewer.policy.yml",
    "--extension", "/repo/omp/plugins/paperclip-review",
    "--no-pty",
  ], "extraArgs must come last, exactly as the adapter appends it");
});

test("an agent armed through first-class keys is not reported as arming nothing", () => {
  const r = checkAgentLaunch({
    agentName: "OMP Engineer",
    adapterConfig: { configFiles: "/repo/omp/engineer.policy.yml", hooks: "/repo/omp/worktree-guard.js" },
    exec: reachedModel,
  });
  assert.equal(r.ok, true, r.detail);
});

test("the required tool is found in the first-class tools key, not only in extraArgs", () => {
  const ok = checkAgentLaunch({
    agentName: "OMP Reviewer",
    adapterConfig: { tools: "read,grep,paperclip_review" },
    requireTool: "paperclip_review",
    exec: reachedModel,
  });
  assert.equal(ok.ok, true, ok.detail);

  const missing = checkAgentLaunch({
    agentName: "OMP Reviewer",
    adapterConfig: { tools: "read,grep" },
    requireTool: "paperclip_review",
    exec: reachedModel,
  });
  assert.equal(missing.ok, false, "a Reviewer with no write-capable tool must fail the gate");
});

test("the launch gate fails an agent that arms nothing", () => {
  // An adapterConfig that declares no policy, hook, tool or extension produces
  // an empty argv, so the agent would launch on the CLI's own defaults — which
  // for the Reviewer means regaining write access.
  const r = checkAgentLaunch({ agentName: "OMP Engineer", adapterConfig: {}, exec: reachedModel });
  assert.equal(r.ok, false, "an empty adapterConfig arms nothing");
  assert.match(r.detail, /nothing reaches OMP|defaults/);
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

// ── Hermes launch gate ───────────────────────────────────────────────────────
// The probe runs `hermes chat --help` — argument parsing only, nothing billed,
// no provider contacted — and passes only when the installed CLI advertises
// every flag the configured argv would emit.
const HELP_TEXT = [
  "usage: hermes chat [-h] [-q QUERY | --query-file PATH] [--oneshot]",
  "                   [--image IMAGE] [-m MODEL] [-t TOOLSETS]",
  "                   [--provider PROVIDER] [-v] [-Q] [--resume SESSION_ID]",
  "                   [--worktree] [--checkpoints] [--max-turns N] [--yolo]",
  "                   [--source SOURCE] [--ignore-rules]",
  "",
  "options:",
  "  --worktree, -w        Run in an isolated git worktree",
  "  --ignore-rules        Skip auto-injection of AGENTS.md",
].join("\n");

test("the Hermes launch gate passes only when the installed CLI advertises every configured flag", () => {
  const ok = checkHermesLaunch({
    agentName: "Hermes Generalist",
    adapterConfig: {
      quiet: true, model: "anthropic/x", provider: "openrouter", toolsets: "fs",
      maxTurnsPerRun: 3, worktreeMode: true, checkpoints: true, verbose: true,
      extraArgs: ["--ignore-rules"],
    },
    exec: () => ({ status: 0, stdout: HELP_TEXT, stderr: "" }),
  });
  assert.equal(ok.ok, true, ok.detail);

  // A flag the installed CLI does not know: the config is fine, the INSTALL is
  // wrong, and the dispatch would die at argument parsing.
  const missingFlag = checkHermesLaunch({
    agentName: "Hermes Generalist",
    adapterConfig: { maxTurnsPerRun: 3 },
    exec: () => ({ status: 0, stdout: HELP_TEXT.replace("[--max-turns N] ", ""), stderr: "" }),
  });
  assert.equal(missingFlag.ok, false, "an unadvertised configured flag must fail");
  assert.match(missingFlag.detail, /--max-turns/);
});

test("the Hermes launch gate treats an unrunnable, failing, or inconclusive probe as a failure", () => {
  const enoent = checkHermesLaunch({
    agentName: "Hermes Generalist", adapterConfig: {},
    exec: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }),
  });
  assert.equal(enoent.ok, false, "a probe that could not run proves nothing");
  assert.match(enoent.detail, /ENOENT|could not/i);

  const nonzero = checkHermesLaunch({
    agentName: "Hermes Generalist", adapterConfig: {},
    exec: () => ({ status: 1, stdout: "", stderr: "argument parser blew up" }),
  });
  assert.equal(nonzero.ok, false, "a probe whose own command failed proves nothing");

  const silent = checkHermesLaunch({
    agentName: "Hermes Generalist", adapterConfig: {},
    exec: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.equal(silent.ok, false, "empty output is inconclusive, not a pass");

  const notUsage = checkHermesLaunch({
    agentName: "Hermes Generalist", adapterConfig: {},
    exec: () => ({ status: 0, stdout: "hello world", stderr: "" }),
  });
  assert.equal(notUsage.ok, false, "output that documents no chat subcommand is inconclusive");
});

// ── Reviewer task-denial gate ────────────────────────────────────────────────

test("the reviewer task-denial gate asserts BOTH independent denial layers", () => {
  const REAL = path.resolve(__dirname, "../../omp/reviewer.policy.yml");
  const reviewer = { name: "OMP Reviewer",
    adapterConfig: { tools: "read,grep,glob,lsp,todo,paperclip_review" } };

  const ok = checkReviewerDenial({ agent: reviewer, policyPath: REAL });
  assert.equal(ok.ok, true, ok.detail);

  const granted = checkReviewerDenial({
    agent: { name: "OMP Reviewer", adapterConfig: { tools: "read,task" } },
    policyPath: REAL,
  });
  assert.equal(granted.ok, false, "task in the allowlist would arm paid fan-out");
  assert.match(granted.detail, /task/);

  const smuggled = checkReviewerDenial({
    agent: { name: "OMP Reviewer",
      adapterConfig: { tools: "read", extraArgs: ["--tools", "read,task"] } },
    policyPath: REAL,
  });
  assert.equal(smuggled.ok, false,
    "an allowlist smuggled through extraArgs --tools must be caught too");

  const weakPolicy = checkReviewerDenial({
    agent: reviewer, policyPath: "/synthetic.yml",
    readFileSync: () => "tools:\n  approval:\n    bash: deny\n",
  });
  assert.equal(weakPolicy.ok, false,
    "the CLI-layer allowlist must not be the only thing withholding the tool");
  assert.match(weakPolicy.detail, /task: deny/);

  const unreadable = checkReviewerDenial({
    agent: reviewer, policyPath: "/no/such.yml",
    readFileSync: () => { throw new Error("ENOENT: no such file"); },
  });
  assert.equal(unreadable.ok, false, "an unreadable policy overlay proves nothing");

  const noReviewer = checkReviewerDenial({ agent: null, policyPath: REAL });
  assert.equal(noReviewer.ok, false, "no reviewer agent means no denial is proven");
});

// ── routing by adapterType ──────────────────────────────────────────────────

test("launch gates route by adapterType, never by role name", () => {
  let seen = null;
  const hermesExec = (cmd, args) => {
    seen = args;
    return { status: 0, stdout: HELP_TEXT, stderr: "" };
  };
  const hermes = agentLaunchGate({
    name: "Hermes Generalist", adapterType: "hermes_local", adapterConfig: {},
  }, { exec: hermesExec });
  assert.equal(hermes.ok, true, hermes.detail);
  assert.deepEqual(seen, ["chat", "--help"],
    "a hermes_local agent is probed with the Hermes help probe, never OMP argv");

  const ompExec = (cmd, args) => {
    seen = args;
    return reachedModel();
  };
  const omp = agentLaunchGate({
    name: "OMP Engineer", adapterType: "omp_local",
    adapterConfig: { configFiles: "/repo/omp/engineer.policy.yml" },
  }, { exec: ompExec });
  assert.equal(omp.ok, true, omp.detail);
  assert.ok(seen.includes("factory-preflight/deliberately-invalid"),
    "an omp_local agent is probed with OMP argv, never the Hermes probe");

  const unknown = agentLaunchGate({
    name: "X", adapterType: "pi_local", adapterConfig: {},
  }, { exec: () => { throw new Error("no probe exists for this adapter"); } });
  assert.equal(unknown.ok, false,
    "an unknown adapterType has no probe; pretending either argv proves its launch would be a lie");
  assert.match(unknown.detail, /pi_local/);

  const hermesWithRequiredTool = agentLaunchGate({
    name: "Hermes Generalist", adapterType: "hermes_local", adapterConfig: {},
  }, { requireTool: "paperclip_review",
    exec: () => { throw new Error("must not probe at all"); } });
  assert.equal(hermesWithRequiredTool.ok, false,
    "a role that requires a specific tool must fail closed on an adapter that cannot prove it");
});

// ── run(): the generalist gate is skipped until a generalist is declared ─────

test("run() skips the Hermes gate while no generalist is declared, and runs it once declared", async () => {
  const C = { red: (s) => s, green: (s) => s, dim: (s) => s };
  const root = path.resolve(__dirname, "..", "..");
  const baseCfg = {
    _file: "factory.config.json", _root: root,
    company: { name: "Local Factory" },
    issues: [{ identifier: "Z-1" }],
    agents: [
      { name: "OMP Reviewer", role: "reviewer", adapterType: "omp_local",
        adapterConfig: { tools: "read,paperclip_review" } },
      { name: "OMP Engineer", role: "engineer", adapterType: "omp_local",
        adapterConfig: { configFiles: "/repo/omp/engineer.policy.yml" } },
    ],
  };
  const argvFor = { _: ["preflight", "Z-1"] };
  const hermesAgent = { name: "Hermes Generalist", role: "generalist",
    adapterType: "hermes_local", adapterConfig: {} };
  const execWith = (hermesResult) => (cmd, args) => {
    if (cmd === "bash") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "chat") return hermesResult;
    return reachedModel();
  };
  // The fake serves the run history too: preflight now asks whether this issue
  // is already repeating a launch failure, and an unreadable history fails
  // closed by design.
  const cleanHistoryApi = {
    baseUrl: "http://x",
    get: async (p) => {
      if (p === "/api/companies") return [{ id: "c1", name: "Local Factory" }];
      if (p === "/api/companies/c1/issues") return [{ id: "z1", identifier: "Z-1" }];
      if (p === "/api/issues/z1") return { id: "z1", identifier: "Z-1" };
      if (p === "/api/issues/z1/runs") return [];
      throw new Error(`GET ${p}`);
    },
  };
  const stubs = (exec) => ({
    connect: () => cleanHistoryApi,
    requireHealthy: async () => {},
    C, exec,
  });

  const rcNoGeneralist = await run(baseCfg, argvFor,
    stubs(execWith({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") })));
  assert.equal(rcNoGeneralist, 0,
    "no generalist declared: the gate is SKIPPED, so even an unrunnable hermes must not fail preflight");

  const rcHermesOk = await run({ ...baseCfg, agents: [...baseCfg.agents, hermesAgent] },
    argvFor, stubs(execWith({ status: 0, stdout: HELP_TEXT, stderr: "" })));
  assert.equal(rcHermesOk, 0, "a declared generalist with an advertising CLI passes");

  const rcHermesFails = await run({ ...baseCfg, agents: [...baseCfg.agents, hermesAgent] },
    argvFor, stubs(execWith({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") })));
  assert.equal(rcHermesFails, 1,
    "once declared, the generalist gate runs and an unrunnable hermes fails the summary");
});

// ── run(): an UNDECLARED issue is the normal case for a handoff-created child ──
//
// preflight used to refuse any identifier absent from factory.config.json:
//
//     const issue = cfg.issues.find((i) => i.identifier === identifier);
//     if (!issue) { ... return 2; }
//
// but every one of its gates is AGENT-level — the verifier, the two launch
// probes, the reviewer denial, the Hermes probe, the health check. None reads
// the issue. So the lookup refused to prove agent-level facts about a child
// that Hermes created, for no reason connected to what it checks.
//
// The identifier still has to mean something, though. For an undeclared issue
// the objective lives only in its spec document, so preflight resolves it —
// which is the one genuinely issue-specific thing it can prove, and exactly
// what fails when a handoff half-completed.

test("run() serves an undeclared issue by resolving its objective from the live spec document", async () => {
  const C = { red: (s) => s, green: (s) => s, dim: (s) => s };
  const root = path.resolve(__dirname, "..", "..");
  const { renderObjectiveDocument, objectiveHash, objectiveCriteriaHash } = require("../../lib/contracts");

  const objective = {
    schemaVersion: "ObjectiveEnvelopeV1",
    objectiveId: "ZEI-9", issueIdentifier: "ZEI-9", revision: 1,
    objectiveHash: "sha256:" + "0".repeat(64), criteriaHash: "sha256:" + "0".repeat(64),
    title: "A child no config declares", originalRequest: "Fix the thing.",
    repository: { path: "/tmp/repo", baseCommit: "1e274df", branch: "paperclip/ZEI-9" },
    permissions: { filesystem: { read: ["."], write: ["src/a.js"] }, network: "provider_only", externalEffects: [] },
    limits: { wallClockMinutes: 15, costCeilingUsd: 1, outerFactoryCostCeilingUsd: 2, maxReviewRounds: 2 },
    verificationLevel: "important",
    expectedOutputs: ["a.js works"], constraints: ["Consume the supplied workspace."],
    acceptanceCriteria: [{ id: "ZEI-9-AC-01", requirement: "passes", command: { argv: ["node", "--test"], cwd: "." } }],
  };
  objective.criteriaHash = objectiveCriteriaHash(objective);
  objective.objectiveHash = objectiveHash(objective);

  const cfg = {
    _file: "factory.config.json", _root: root,
    company: { name: "Local Factory" },
    issues: [],  // ZEI-9 is declared NOWHERE — the whole point
    agents: [
      { name: "OMP Reviewer", role: "reviewer", adapterType: "omp_local",
        adapterConfig: { tools: "read,paperclip_review" } },
      { name: "OMP Engineer", role: "engineer", adapterType: "omp_local",
        adapterConfig: { configFiles: "/repo/omp/engineer.policy.yml" } },
    ],
  };
  const exec = (cmd) => (cmd === "bash" ? { status: 0, stdout: "", stderr: "" } : reachedModel());
  const api = {
    get: async (p) => {
      if (p === "/api/companies") return [{ id: "c1", name: "Local Factory" }];
      if (p === "/api/companies/c1/issues") return [{ id: "child-uuid", identifier: "ZEI-9" }];
      if (p === "/api/issues/child-uuid") return { id: "child-uuid", identifier: "ZEI-9" };
      if (p === "/api/issues/child-uuid/documents/spec") return { body: renderObjectiveDocument(objective) };
      if (p === "/api/issues/child-uuid/runs") return [];
      throw new Error(`GET ${p}`);
    },
  };
  const stubs = { connect: () => ({ ...api, baseUrl: "http://x" }), requireHealthy: async () => {}, C, exec };

  const rc = await run(cfg, { _: ["preflight", "ZEI-9"] }, stubs);
  assert.equal(rc, 0, "an undeclared child with a resolvable objective must pass preflight");
});

test("run() fails an undeclared issue whose spec document never installed", async () => {
  // The half-completed handoff: the child exists, but its objective does not.
  // Dispatching it would wake an Engineer with nothing to work against.
  const C = { red: (s) => s, green: (s) => s, dim: (s) => s };
  const root = path.resolve(__dirname, "..", "..");
  const cfg = {
    _file: "factory.config.json", _root: root,
    company: { name: "Local Factory" },
    issues: [],
    agents: [
      { name: "OMP Reviewer", role: "reviewer", adapterType: "omp_local",
        adapterConfig: { tools: "read,paperclip_review" } },
      { name: "OMP Engineer", role: "engineer", adapterType: "omp_local",
        adapterConfig: { configFiles: "/repo/omp/engineer.policy.yml" } },
    ],
  };
  const exec = (cmd) => (cmd === "bash" ? { status: 0, stdout: "", stderr: "" } : reachedModel());
  const api = {
    get: async (p) => {
      if (p === "/api/companies") return [{ id: "c1", name: "Local Factory" }];
      if (p === "/api/companies/c1/issues") return [{ id: "child-uuid", identifier: "ZEI-9" }];
      if (p === "/api/issues/child-uuid") return { id: "child-uuid", identifier: "ZEI-9" };
      if (p === "/api/issues/child-uuid/documents/spec") return null;  // never installed
      throw new Error(`GET ${p}`);
    },
  };
  const stubs = { connect: () => ({ ...api, baseUrl: "http://x" }), requireHealthy: async () => {}, C, exec };

  const rc = await run(cfg, { _: ["preflight", "ZEI-9"] }, stubs);
  assert.equal(rc, 1, "a child with no objective must not pass preflight");
});

// ── run(): the repeated-launch-failure gate ─────────────────────────────────

test("run() refuses an issue that is already repeating an identical launch failure", async () => {
  // The 2026-09-02 condition, replayed through the real entrypoint: nine
  // adapter_failed runs and nothing changed between them. Every other gate
  // passes; this one must still block the tenth dispatch.
  const C = { red: (s) => s, green: (s) => s, dim: (s) => s };
  const root = path.resolve(__dirname, "..", "..");
  const failedRun = (i) => ({
    runId: `r${i}`, status: "failed", errorCode: "adapter_failed",
    invocationSource: i % 3 === 2 ? "assignment" : "automation",
    createdAt: `2026-09-02T18:3${i}:00.000Z`, usageJson: { costUsd: 0 },
  });
  const api = {
    baseUrl: "http://x",
    get: async (p) => {
      if (p === "/api/companies") return [{ id: "c1", name: "Local Factory" }];
      if (p === "/api/companies/c1/issues") return [{ id: "i1", identifier: "Z-1" }];
      if (p === "/api/issues/i1") return { id: "i1", identifier: "Z-1" };
      if (p === "/api/issues/i1/runs") return [0, 1, 2, 3, 4, 5, 6, 7, 8].map(failedRun);
      throw new Error(`GET ${p}`);
    },
  };
  const cfg = {
    _file: "factory.config.json", _root: root,
    company: { name: "Local Factory" },
    issues: [{ identifier: "Z-1" }],
    agents: [
      { name: "OMP Reviewer", role: "reviewer", adapterType: "omp_local",
        adapterConfig: { tools: "read,paperclip_review" } },
      { name: "OMP Engineer", role: "engineer", adapterType: "omp_local",
        adapterConfig: { configFiles: "/repo/omp/engineer.policy.yml" } },
    ],
  };
  const exec = (cmd) => (cmd === "bash" ? { status: 0, stdout: "", stderr: "" } : reachedModel());
  const rc = await run(cfg, { _: ["preflight", "Z-1"] },
    { connect: () => api, requireHealthy: async () => {}, C, exec });
  assert.equal(rc, 1, "preflight must block a dispatch that would only repeat a known failure");
});

test("run() fails closed when the run history cannot be read", async () => {
  const C = { red: (s) => s, green: (s) => s, dim: (s) => s };
  const root = path.resolve(__dirname, "..", "..");
  const api = {
    baseUrl: "http://x",
    get: async (p) => {
      if (p === "/api/companies") return [{ id: "c1", name: "Local Factory" }];
      if (p === "/api/companies/c1/issues") return [{ id: "i1", identifier: "Z-1" }];
      throw new Error("route not found");
    },
  };
  const cfg = {
    _file: "factory.config.json", _root: root,
    company: { name: "Local Factory" },
    issues: [{ identifier: "Z-1" }],
    agents: [
      { name: "OMP Reviewer", role: "reviewer", adapterType: "omp_local",
        adapterConfig: { tools: "read,paperclip_review" } },
      { name: "OMP Engineer", role: "engineer", adapterType: "omp_local",
        adapterConfig: { configFiles: "/repo/omp/engineer.policy.yml" } },
    ],
  };
  const exec = (cmd) => (cmd === "bash" ? { status: 0, stdout: "", stderr: "" } : reachedModel());
  const rc = await run(cfg, { _: ["preflight", "Z-1"] },
    { connect: () => api, requireHealthy: async () => {}, C, exec });
  assert.equal(rc, 1, "an unreadable history has not shown the issue is clear of the condition");
});

// ── the verifier must be EXECUTABLE, not merely present ────────────────────
//
// ops/omp-verify-bwrap.sh was committed 100644 while every sibling ops script
// is 100755. lib/review.js#runAcceptanceChecks executes it directly —
// exec(verifierPath, args) — so the missing bit made every spawn fail with
// EACCES and report exitCode null.
//
// The consequence was silent and total: `deterministicResults` recorded
// `exitCode: null, passed: false` for every criterion, the derived disposition
// correctly refused to approve over an unconfirmed check, and no review could
// ever pass. The canary's assessment shows exactly that — a model PASS on
// ZEI-2-AC-01 alongside a deterministic result that never ran.
//
// The gate did not catch it because it probed `bash <path>`, which ignores the
// executable bit, while the real caller executes the file. A gate that models
// the launch more generously than the launch proves nothing — the same lesson
// stringList already records for the adapter's list separator.

test("the verifier gate executes the script the way review.js does", () => {
  const C = { red: (s) => s, green: (s) => s, dim: (s) => s };
  void C;
  const seen = [];
  const exec = (file, args) => { seen.push([file, args?.[0]]); return { status: 0, stdout: "", stderr: "" }; };
  const verifierPath = path.resolve(__dirname, "../../ops/omp-verify-bwrap.sh");
  checkVerifier({ verifierPath, exec });
  assert.equal(seen[0][0], verifierPath,
    "the probe must invoke the verifier itself, not `bash <path>`: only the direct form " +
    "exercises the executable bit that runAcceptanceChecks depends on");
});

test("a verifier that is not executable fails the gate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-"));
  const p = path.join(dir, "omp-verify-bwrap.sh");
  fs.writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n");
  fs.chmodSync(p, 0o644);
  const g = checkVerifier({ verifierPath: p, exec: () => ({ error: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }) }) });
  assert.equal(g.ok, false);
  assert.match(g.detail, /executable/i, "name the bit, so the fix is obvious");
});

test("the shipped verifier is executable", () => {
  // The regression itself, asserted against the file that ships.
  const p = path.resolve(__dirname, "../../ops/omp-verify-bwrap.sh");
  assert.doesNotThrow(() => fs.accessSync(p, fs.constants.X_OK),
    `${p} is not executable; lib/review.js executes it directly and every acceptance ` +
    `check will report exitCode null`);
});
