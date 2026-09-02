"use strict";
// The server canonicalizes adapterConfig.env; the factory must compare by meaning.
//
// `envBindingSchema` accepts a bare string for backward compatibility and stores
// it as {type:"plain", value}. A literal deep-equal on readback therefore reports
// the 200-and-do-nothing class for a write that landed perfectly — and, because
// no config edit can make the string come back, it never clears. These tests pin
// the normalization AND pin that it did not weaken the real drop detector.
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeEnvBindings, compareEnv } = require("../../lib/semdiff");
const { planAgents } = require("../../lib/plan");

const DESIRED = {
  FACTORY_ENGINEER_MODEL: "anthropic/claude-opus-5",
  FACTORY_REVIEWER_MODEL: "openai-codex/gpt-5.6-sol",
};
const CANONICAL = {
  FACTORY_ENGINEER_MODEL: { type: "plain", value: "anthropic/claude-opus-5" },
  FACTORY_REVIEWER_MODEL: { type: "plain", value: "openai-codex/gpt-5.6-sol" },
};

test("a bare string binding normalizes to the server's plain envelope", () => {
  assert.deepEqual(normalizeEnvBindings(DESIRED), CANONICAL);
  // Already-canonical input is a fixed point.
  assert.deepEqual(normalizeEnvBindings(CANONICAL), CANONICAL);
});

test("secret_ref bindings pass through structurally untouched", () => {
  const ref = { API_KEY: { type: "secret_ref", secretId: "0e1f2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7" } };
  assert.deepEqual(normalizeEnvBindings(ref), ref);
});

test("string form and envelope form compare EQUAL in both directions", () => {
  assert.equal(compareEnv(DESIRED, CANONICAL), true);
  assert.equal(compareEnv(CANONICAL, DESIRED), true);
});

test("normalization does not hide a genuinely different value", () => {
  const wrongModel = {
    ...CANONICAL,
    FACTORY_REVIEWER_MODEL: { type: "plain", value: "anthropic/claude-opus-5" },
  };
  assert.equal(compareEnv(DESIRED, wrongModel), false,
    "a reviewer silently sharing the engineer's model must still register as drift");
});

test("normalization does not hide a MISSING or extra key", () => {
  const { FACTORY_REVIEWER_MODEL, ...missing } = CANONICAL;
  assert.equal(compareEnv(DESIRED, missing), false);
  assert.equal(compareEnv(DESIRED, { ...CANONICAL, EXTRA: { type: "plain", value: "x" } }), false);
  assert.equal(compareEnv(DESIRED, undefined), false);
});

// ---------------------------------------------------------------- planner

function agentCfg(env) {
  return {
    name: "OMP Reviewer",
    adapterConfig: { model: "openai-codex/gpt-5.6-sol", env },
  };
}
function snapWith(liveEnv) {
  return {
    agents: {
      "OMP Reviewer": {
        id: "f5231bf2-486e-4ed8-b8d2-1cb8a27db7e6",
        adapterConfig: { model: "openai-codex/gpt-5.6-sol", env: liveEnv },
      },
    },
  };
}

test("planner reports NO drift when live env is the canonical form of the config", () => {
  const actions = [];
  planAgents({ agents: [agentCfg(DESIRED)] }, snapWith(CANONICAL), actions);
  assert.deepEqual(actions, [], "canonicalized env must not re-PATCH forever");
});

test("planner still reports drift when the env values genuinely differ", () => {
  const actions = [];
  const live = { ...CANONICAL, FACTORY_REVIEWER_MODEL: { type: "plain", value: "anthropic/claude-opus-5" } };
  planAgents({ agents: [agentCfg(DESIRED)] }, snapWith(live), actions);
  assert.equal(actions.length, 1);
  assert.match(actions[0].what, /env/);
});

test("the readback assertion for env accepts the canonical form the server returns", () => {
  const actions = [];
  planAgents({ agents: [agentCfg(DESIRED)] }, snapWith({ STALE: { type: "plain", value: "old" } }), actions);
  assert.equal(actions.length, 1);
  const envExpect = actions[0].expect.find((e) => e.path === "adapterConfig.env");
  assert.ok(envExpect.compare, "env must be checked by a semantic predicate, not deep-equal");
  assert.equal(envExpect.compare(CANONICAL), true, "the server's canonical readback must satisfy it");
  assert.equal(envExpect.compare(undefined), false, "a genuinely dropped env must still fail");
  assert.equal(
    envExpect.compare({ FACTORY_ENGINEER_MODEL: { type: "plain", value: "anthropic/claude-opus-5" } }),
    false,
    "a partially dropped env must still fail",
  );
});

// ---------------------------------------------------------------- config comments

const { stripComments, load, factoryRoot } = require("../../lib/config");

test("stripComments removes SUFFIXED comment keys, not just the bare $comment", () => {
  const out = stripComments({
    $comment: "gone",
    $comment_maxReviewRounds: "gone too",
    $comment_responsibleUser: "and this",
    maxReviewRounds: 2,
    nested: { $comment_x: "gone", keep: 1 },
    list: [{ $comment_y: "gone", keep: 2 }],
  });
  assert.deepEqual(out, { maxReviewRounds: 2, nested: { keep: 1 }, list: [{ keep: 2 }] });
});

test("a key that merely CONTAINS $comment is not stripped", () => {
  assert.deepEqual(stripComments({ "not$comment": 1, "$commentary": 2 }),
    { "not$comment": 1, "$commentary": 2 });
});

test("the loaded executionPolicy carries no documentation into the payload", () => {
  const root = factoryRoot(__dirname);
  const cfg = load(require("node:path").join(root, "factory.config.json"));
  const policy = cfg.issues.find((i) => i.identifier === "ZEI-1").executionPolicy;
  const leaked = Object.keys(policy).filter((k) => k.startsWith("$comment"));
  assert.deepEqual(leaked, [],
    "executionPolicy is sent to the server whole; a comment key in it is permanent drift");
});
