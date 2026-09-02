"use strict";
// Per-adapter managed keys and the Hermes launch argv. The managed lists are
// per-adapter because omp_local and hermes_local read DISJOINT key sets from
// disjoint shipped adapter implementations; one shared allowlist would leave
// a Hermes key unreconciled or report phantom removal drift on an OMP-only
// key. An unknown adapterType must fail the plan, never reconcile zero keys.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  planAgents, managedKeysFor, ADAPTER_MANAGED_KEYS,
} = require("../../lib/plan");
const { FactoryError } = require("../../lib/util");
const { hermesArgv, HERMES_PREFLIGHT_PROMPT } = require("../../lib/preflight");

const ompAgent = (adapterConfig) => ({
  name: "OMP Reviewer", role: "reviewer", adapterType: "omp_local", adapterConfig,
});
const ompSnap = (liveAdapterConfig) =>
  ({ agents: { "OMP Reviewer": { id: "a1", adapterConfig: liveAdapterConfig } } });
const ompCfg = (adapterConfig) => ({ agents: [ompAgent(adapterConfig)] });

const hermesAgent = (adapterConfig) => ({
  name: "Hermes Generalist", role: "generalist", adapterType: "hermes_local", adapterConfig,
});
const hermesSnap = (liveAdapterConfig) =>
  ({ agents: { "Hermes Generalist": { id: "h1", adapterConfig: liveAdapterConfig } } });
const hermesCfg = (adapterConfig) => ({ agents: [hermesAgent(adapterConfig)] });

// ── the two managed lists ────────────────────────────────────────────────────

test("omp_local manages the previous fifteen keys plus profile and noRules", () => {
  const omp = ADAPTER_MANAGED_KEYS.omp_local;
  for (const k of ["command", "model", "thinking", "timeoutSec", "graceSec",
    "env", "approvalMode", "autoApprove", "tools", "skills", "configFiles",
    "extensions", "pluginDirs", "hooks", "extraArgs", "profile", "noRules"]) {
    assert.ok(omp.includes(k), `${k} must be managed for omp_local`);
  }
  assert.equal(omp.length, 17,
    "exactly the verified keys; a speculative addition changes what `factory apply` may write");
  assert.ok(!omp.includes("instructionsFilePath"),
    "server-managed: reconciling it would unbind the materialized AGENTS.md");
  for (const k of ["hermesCommand", "cwd", "provider", "toolsets", "persistSession",
    "worktreeMode", "checkpoints", "quiet", "verbose", "maxTurnsPerRun",
    "promptTemplate", "paperclipApiUrl"]) {
    assert.ok(!omp.includes(k), `${k} is a hermes_local key; it has no meaning on omp_local`);
  }
});

test("hermes_local manages exactly the adapter's verified first-class keys", () => {
  const hermes = ADAPTER_MANAGED_KEYS.hermes_local;
  for (const k of ["hermesCommand", "cwd", "model", "provider", "toolsets",
    "persistSession", "worktreeMode", "checkpoints", "quiet", "verbose",
    "maxTurnsPerRun", "timeoutSec", "graceSec", "env", "extraArgs",
    "promptTemplate", "paperclipApiUrl"]) {
    assert.ok(hermes.includes(k), `${k} must be managed for hermes_local`);
  }
  assert.equal(hermes.length, 17,
    "exactly the verified keys; a speculative addition changes what `factory apply` may write");
  for (const k of ["instructionsFilePath", "tools", "skills", "configFiles",
    "extensions", "hooks", "noRules", "profile"]) {
    assert.ok(!hermes.includes(k), `${k} must not be managed for hermes_local`);
  }
});

test("the two lists overlap only on keys both adapters genuinely read", () => {
  // Verified against the shipped implementations: omp_local manages
  // `command`, not `cwd`, so cwd is NOT in the overlap.
  const overlap = ADAPTER_MANAGED_KEYS.omp_local
    .filter((k) => ADAPTER_MANAGED_KEYS.hermes_local.includes(k));
  assert.deepEqual(overlap, ["model", "timeoutSec", "graceSec", "env", "extraArgs"]);
});

// ── managedKeysFor ───────────────────────────────────────────────────────────

test("managedKeysFor returns the list for the declared adapter type", () => {
  assert.equal(managedKeysFor(ompAgent({})), ADAPTER_MANAGED_KEYS.omp_local);
  assert.equal(managedKeysFor(hermesAgent({})), ADAPTER_MANAGED_KEYS.hermes_local);
});

test("managedKeysFor throws on an unknown adapter type, naming it and the known ones", () => {
  assert.throws(
    () => managedKeysFor({ name: "A", adapterType: "pi_local" }),
    (err) => err instanceof FactoryError
      && /pi_local/.test(err.message)
      && /omp_local, hermes_local/.test(err.message),
    "an unknown type must fail loudly, not reconcile zero keys",
  );
});

// The pre-restructure shared single-adapter allowlist must be gone with no
// alias or re-export. Proven by key-prefix so the assertion does not have to
// spell the retired name and reintroduce it into the tree.
test("the single shared managed-key allowlist is gone from the plan module", () => {
  const plan = require("../../lib/plan");
  assert.ok(plan.ADAPTER_MANAGED_KEYS, "the per-adapter replacement must exist");
  assert.deepEqual(
    Object.keys(plan).filter((k) => k.startsWith("AGENT_")),
    [],
    "the shared allowlist must not survive as an alias or re-export",
  );
});

// ── planning per adapter ─────────────────────────────────────────────────────

test("planning a hermes_local agent reconciles toolsets and ignores OMP-only keys", () => {
  const actions = [];
  planAgents(
    hermesCfg({ hermesCommand: "/bin/hermes", toolsets: "fs,web" }),
    hermesSnap({ hermesCommand: "/bin/hermes", configFiles: "/y/omp.policy.yml" }),
    actions,
  );
  assert.equal(actions.length, 1, "undeclared toolsets on the live record is drift");
  const action = actions[0];
  assert.equal(action.body.adapterConfig.toolsets, "fs,web");
  assert.match(action.what, /adapterConfig \(toolsets\)$/,
    "an OMP-only key that is legitimately absent is not drift on a Hermes agent");
  assert.equal(action.body.adapterConfig.configFiles, "/y/omp.policy.yml",
    "a key outside the hermes managed list is left to the server record, not deleted");
  assert.ok(!action.expect.some((e) => e.path === "adapterConfig.configFiles"));
  assert.ok(action.expect.some((e) => e.path === "adapterConfig.toolsets"));
});

test("planning an omp_local agent reconciles profile and noRules", () => {
  const actions = [];
  planAgents(
    ompCfg({ command: "/x", profile: "fast", noRules: true }),
    ompSnap({ command: "/x" }),
    actions,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].body.adapterConfig.profile, "fast");
  assert.equal(actions[0].body.adapterConfig.noRules, true);
  assert.ok(actions[0].expect.some((e) => e.path === "adapterConfig.profile"));
  assert.ok(actions[0].expect.some((e) => e.path === "adapterConfig.noRules"));
});

test("an agent with an unknown adapterType fails the plan", () => {
  const actions = [];
  assert.throws(
    () => planAgents(
      { agents: [{ name: "A", role: "engineer", adapterType: "gibberish_local", adapterConfig: {} }] },
      { agents: { A: { id: "a1", adapterConfig: {} } } },
      actions,
    ),
    (err) => err instanceof FactoryError && /gibberish_local/.test(err.message),
  );
  assert.equal(actions.length, 0, "a failed plan must emit no actions");
});

test("instructionsFilePath is never planned away, for either adapter", () => {
  const filePath = "/srv/materialized/AGENTS.md";
  const cases = [
    [ompCfg({ command: "/x", skills: "a" }), ompSnap({ command: "/x", instructionsFilePath: filePath })],
    [hermesCfg({ hermesCommand: "/h", toolsets: "fs" }),
      hermesSnap({ hermesCommand: "/h", instructionsFilePath: filePath })],
  ];
  for (const [cfg, snap] of cases) {
    const actions = [];
    planAgents(cfg, snap, actions);
    assert.equal(actions.length, 1, "the drift on the managed key must still be reconciled");
    assert.equal(actions[0].body.adapterConfig.instructionsFilePath, filePath,
      "the server-materialized instruction bundle must survive the merge");
    assert.ok(!actions[0].expect.some((e) => e.path === "adapterConfig.instructionsFilePath"));
  }
});

// ── hermesArgv: the argv the Hermes adapter will really build ────────────────

test("hermesArgv mirrors the adapter's exact flag order for a fully-populated config", () => {
  const argv = hermesArgv({
    quiet: true, model: "anthropic/x", provider: "openrouter", toolsets: "fs,web",
    maxTurnsPerRun: 12, worktreeMode: true, checkpoints: true, verbose: true,
    extraArgs: ["--ignore-rules"],
  });
  assert.deepEqual(argv, [
    "chat", "-q", HERMES_PREFLIGHT_PROMPT,
    "-Q", "-m", "anthropic/x", "--provider", "openrouter",
    "-t", "fs,web", "--max-turns", "12", "-w", "--checkpoints", "-v",
    "--source", "tool", "--yolo",
    "--ignore-rules",
  ], "extraArgs must come last, exactly as the adapter appends it");
});

test("hermesArgv reduces an empty config to the fixed chat spine", () => {
  assert.deepEqual(hermesArgv({}),
    ["chat", "-q", HERMES_PREFLIGHT_PROMPT, "--source", "tool", "--yolo"]);
});

test("hermesArgv emits an optional flag only under the adapter's own condition", () => {
  assert.deepEqual(
    hermesArgv({ quiet: false, provider: "auto", maxTurnsPerRun: 0,
      worktreeMode: false, checkpoints: false, verbose: false }),
    ["chat", "-q", HERMES_PREFLIGHT_PROMPT, "--source", "tool", "--yolo"],
    "falsy values and provider 'auto' emit nothing, as in the adapter");
  const argv = hermesArgv({ enabledToolsets: ["fs", "web"] });
  const t = argv.indexOf("-t");
  assert.notEqual(t, -1, "the enabledToolsets array alias reaches -t too");
  assert.equal(argv[t + 1], "fs,web");
});

// ── THE SEPARATOR IS NOT THE SAME FOR EVERY KEY ──────────────────────────────
//
// Caught by the first live canary, which cost $0.00 and failed three times with
//
//   error: Config overlay not found: /…/base.overlay.yml,/…/engineer.policy.yml
//
// The adapter's own helper (dist/server/execute.js:31) is
//
//   stringList(value, commaSeparated = false)
//     value.split(commaSeparated ? /[\r\n,]+/ : /\r?\n/)
//
// and it is called with `true` for ONLY three keys — modelCycle (:131),
// tools (:132), skills (:133). Every path-valued key takes the default:
// configFiles (:187), extensions (:189), pluginDirs (:191), hooks (:193).
// For those, a comma is an ordinary filename character, so "a.yml,b.yml" is
// ONE path that does not exist.
//
// preflight's adapterArgv split EVERYTHING on commas. That is why the launch
// probe passed 6/6 while the real dispatch could not start: the probe was
// proving a reconstruction that no adapter ever builds. A gate whose whole
// purpose is to prove the real launch must not model it more forgivingly than
// the thing it stands in for.

const { adapterArgv: argvUnderTest } = require("../../lib/preflight");

test("comma-joined configFiles stay ONE argument, exactly as the adapter treats them", () => {
  const argv = argvUnderTest({ configFiles: "/a/base.yml,/a/policy.yml" });
  const configs = argv.filter((x, i) => argv[i - 1] === "--config");

  assert.deepEqual(configs, ["/a/base.yml,/a/policy.yml"],
    "a comma is not a separator for configFiles; splitting on it hides the defect the canary hit");
});

test("newline-separated configFiles become separate --config flags", () => {
  const argv = argvUnderTest({ configFiles: "/a/base.yml\n/a/policy.yml" });
  const configs = argv.filter((x, i) => argv[i - 1] === "--config");

  assert.deepEqual(configs, ["/a/base.yml", "/a/policy.yml"]);
});

test("an array of configFiles becomes separate --config flags", () => {
  const argv = argvUnderTest({ configFiles: ["/a/base.yml", "/a/policy.yml"] });
  const configs = argv.filter((x, i) => argv[i - 1] === "--config");

  assert.deepEqual(configs, ["/a/base.yml", "/a/policy.yml"],
    "an array is unambiguous and is the shape the factory should declare");
});

test("tools and skills DO split on commas, because the adapter asks them to", () => {
  const argv = argvUnderTest({ tools: "read,paperclip_review", skills: "a,b" });

  assert.deepEqual(argv, ["--tools", "read,paperclip_review", "--skills", "a,b"]);
});

test("extensions, pluginDirs and hooks follow the path rule, not the comma rule", () => {
  for (const key of ["extensions", "pluginDirs", "hooks"]) {
    const flag = { extensions: "--extension", pluginDirs: "--plugin-dir", hooks: "--hook" }[key];
    const argv = argvUnderTest({ [key]: "/a/one,/a/two" });
    const values = argv.filter((x, i) => argv[i - 1] === flag);
    assert.deepEqual(values, ["/a/one,/a/two"], `${key} must not be comma-split`);
  }
});
