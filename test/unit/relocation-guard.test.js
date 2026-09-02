"use strict";
// `factory apply` must refuse to silently move the live agents to a different
// tree.
//
// WHY THIS EXISTS. `${FACTORY_ROOT}` expands to whichever checkout ran the
// command (lib/config.js#factoryRoot resolves from __dirname, not cwd). Live
// state is therefore a function of WHERE YOU APPLIED FROM, not of the declared
// config. Applying from a tree that lacks a mechanism does not report the
// mechanism as missing — it reports a path change, and deletes the mechanism.
//
// On 2026-09-02 `factory diff` from master proposed
//   reconcile agent "OMP Engineer" adapterConfig … [removing env, extensions]
// which would have dropped OMP_PROFILE, the paperclip-goal-guard extension and
// base.overlay.yml, because the newer design lived only on an unmerged branch.
// BUILD_HISTORY.md records the same mechanism at commit 4e7c1a6 as "the single
// most expensive false conclusion in this project's history".
//
// The merge fixed that instance. This gate is the structural half: it makes
// the relocation itself require a deliberate flag, so the next instance
// announces itself instead of applying.

const test = require("node:test");
const assert = require("node:assert/strict");

const { detectRootRelocation, relocationGate } = require("../../lib/preflight");

const ROOT = "/home/lucascoh/factory-stack";
const OTHER = "/home/lucascoh/worktrees/factory-context-arch";

// Shaped like the real reconcile action: adapterConfig before/after objects.
const relocateAction = (from, to) => ({
  id: 'agent:OMP Engineer:adapterConfig',
  kind: "update",
  what: 'reconcile agent "OMP Engineer" adapterConfig',
  before: {
    command: `${from}/ops/omp-bwrap.sh`,
    configFiles: [`${from}/omp/base.overlay.yml`, `${from}/omp/engineer.policy.yml`],
    extensions: [`${from}/omp/plugins/paperclip-goal-guard`],
    model: "anthropic/claude-opus-5",
  },
  after: {
    command: `${to}/ops/omp-bwrap.sh`,
    configFiles: [`${to}/omp/base.overlay.yml`, `${to}/omp/engineer.policy.yml`],
    extensions: [`${to}/omp/plugins/paperclip-goal-guard`],
    model: "anthropic/claude-opus-5",
  },
});

test("a plan that repoints live agents at a different tree is detected", () => {
  const r = detectRootRelocation({ root: ROOT, actions: [relocateAction(OTHER, ROOT)] });
  assert.equal(r.relocating, true);
  assert.deepEqual(r.liveRoots, [OTHER]);
  // Every moved path is enumerated: "something moved" is not reviewable.
  assert.equal(r.moves.length, 4);
  assert.ok(r.moves.every((m) => m.from.startsWith(OTHER) && m.to.startsWith(ROOT)));
});

test("a plan with no path changes is not a relocation", () => {
  const r = detectRootRelocation({
    root: ROOT,
    actions: [{
      id: "agent:OMP Reviewer:adapterConfig", kind: "update", what: "x",
      before: { model: "openai-codex/gpt-5.6-sol", command: `${ROOT}/ops/omp-bwrap.sh` },
      after: { model: "google-antigravity/gemini-3.8-flash-high", command: `${ROOT}/ops/omp-bwrap.sh` },
    }],
  });
  assert.equal(r.relocating, false);
  assert.deepEqual(r.moves, []);
});

test("paths already rooted here are not mistaken for a relocation", () => {
  const r = detectRootRelocation({
    root: ROOT,
    actions: [{
      id: "a", kind: "update", what: "x",
      before: { command: `${ROOT}/ops/old-wrapper.sh` },
      after: { command: `${ROOT}/ops/omp-bwrap.sh` },
    }],
  });
  assert.equal(r.relocating, false, "a genuine file rename inside this tree is ordinary drift");
});

test("several live roots at once are all named", () => {
  const third = "/home/lucascoh/worktrees/factory-finalization";
  const r = detectRootRelocation({
    root: ROOT,
    actions: [relocateAction(OTHER, ROOT), { ...relocateAction(third, ROOT), id: "agent:Hermes:adapterConfig" }],
  });
  assert.equal(r.relocating, true);
  assert.deepEqual(r.liveRoots.sort(), [third, OTHER].sort());
});

test("nested keys are walked, not just top-level strings", () => {
  const r = detectRootRelocation({
    root: ROOT,
    actions: [{
      id: "a", kind: "update", what: "x",
      before: { env: { OMP_PROFILE: { type: "plain", value: `${OTHER}/omp/profiles/e` } } },
      after: { env: { OMP_PROFILE: { type: "plain", value: `${ROOT}/omp/profiles/e` } } },
    }],
  });
  assert.equal(r.relocating, true);
  assert.equal(r.moves.length, 1);
  assert.equal(r.moves[0].path, "env.OMP_PROFILE.value");
});

// ---- the gate ----

test("the gate refuses a relocation that was not asked for", () => {
  const g = relocationGate({ root: ROOT, actions: [relocateAction(OTHER, ROOT)], allowRelocate: false });
  assert.equal(g.ok, false);
  assert.match(g.detail, /--relocate/);
  assert.match(g.detail, /factory-context-arch/, "the tree being left must be named");
  assert.match(g.detail, /factory-stack/, "the tree being moved to must be named");
});

test("the gate allows a relocation that was explicitly asked for", () => {
  const g = relocationGate({ root: ROOT, actions: [relocateAction(OTHER, ROOT)], allowRelocate: true });
  assert.equal(g.ok, true);
  assert.match(g.detail, /--relocate/, "an authorised relocation still says what it did");
});

test("the gate passes a plan that relocates nothing, with or without the flag", () => {
  const actions = [{ id: "a", kind: "update", what: "x", before: { model: "a" }, after: { model: "b" } }];
  assert.equal(relocationGate({ root: ROOT, actions, allowRelocate: false }).ok, true);
  assert.equal(relocationGate({ root: ROOT, actions, allowRelocate: true }).ok, true);
});

// ---- MUTANT CHECK: the guard must be load-bearing inside applyPlan ----

test("applyPlan itself refuses, so the guard cannot be bypassed by another caller", async () => {
  const { applyPlan } = require("../../lib/apply");
  const { FactoryError } = require("../../lib/util");
  const plan = { planHash: "h", actions: [relocateAction(OTHER, ROOT)] };
  const api = {
    trace: [],
    get: async () => { throw new Error("apply must refuse BEFORE touching the API"); },
    post: async () => { throw new Error("apply must refuse BEFORE touching the API"); },
    mutate: async () => { throw new Error("apply must refuse BEFORE touching the API"); },
  };
  await assert.rejects(
    () => applyPlan(api, { _root: ROOT }, plan, { expectedHash: "h" }),
    (err) => {
      assert.ok(err instanceof FactoryError);
      assert.match(err.message, /--relocate/);
      return true;
    },
  );
});

test("applyPlan proceeds when the relocation is authorised", async () => {
  const { applyPlan } = require("../../lib/apply");
  const plan = { planHash: "h", actions: [relocateAction(OTHER, ROOT)] };
  const api = { get: async () => ({}), post: async () => ({}), mutate: async () => ({}), trace: [] };
  // dryRun keeps this a guard test rather than an apply test; reaching the
  // dry-run result at all proves the refusal did not fire.
  const stored = await applyPlan(api, { _root: ROOT }, plan, { expectedHash: "h", dryRun: true, allowRelocate: true });
  assert.equal(stored.receipt.actions[0].status, "dry-run");
});

test("a dry run is still refused without the flag — it is what the operator reads to decide", async () => {
  const { applyPlan } = require("../../lib/apply");
  const plan = { planHash: "h", actions: [relocateAction(OTHER, ROOT)] };
  const api = { get: async () => ({}), post: async () => ({}), mutate: async () => ({}), trace: [] };
  await assert.rejects(
    () => applyPlan(api, { _root: ROOT }, plan, { expectedHash: "h", dryRun: true }),
    /--relocate/,
  );
});
