"use strict";
// The full submission path of `paperclip_review`: what the Reviewer's one
// write-capable tool actually does to the live control plane, and — more
// importantly — everything it refuses to do.
//
// The two writes it may perform are both narrow:
//   1. PUT the assessment document for the CURRENT issue (optimistic + readback)
//   2. PATCH that issue's status with the required decision comment
//      (services/issue-execution-policy.js:607/664 — a stage decision without a
//      comment is rejected 422; there is no separate decision endpoint)

const test = require("node:test");
const assert = require("node:assert/strict");
const { submitReview } = require("../../lib/review");
const { PaperclipApi } = require("../../lib/api");
const { FactoryError, hashText } = require("../../lib/util");

const ENV = {
  PAPERCLIP_TASK_ID: "issue-uuid-1",
  PAPERCLIP_RUN_ID: "run-uuid-1",
  PAPERCLIP_API_URL: "http://127.0.0.1:3100",
  PAPERCLIP_API_KEY: "agent-jwt-token",
  PAPERCLIP_WORKSPACE_WORKTREE_PATH: "/worktrees/ZEI-1",
  PAPERCLIP_WORKSPACE_BRANCH: "paperclip/ZEI-1",
};

const OBJECTIVE = {
  schemaVersion: "ObjectiveEnvelopeV1",
  objectiveId: "ZEI-1", issueIdentifier: "ZEI-1", revision: 1,
  objectiveHash: "sha256:" + "a".repeat(64),
  criteriaHash: "sha256:" + "b".repeat(64),
  repository: { path: "/repo", baseCommit: "3cb8238", branch: "paperclip/ZEI-1" },
  acceptanceCriteria: [
    { id: "ZEI-1-AC-01", command: { argv: ["python3", "-m", "pytest", "-q"], cwd: "." } },
    { id: "ZEI-1-AC-02", command: { argv: ["python3", "-m", "pytest", "-q", "tests/x.py"], cwd: "." } },
  ],
};

// A Paperclip that behaves like the shipped one: `body` on the wire, a fresh
// revision id per document write, and a stage decision that REQUIRES a comment.
function server({ assessment = null, issue = { id: "issue-uuid-1", status: "in_review" } } = {}) {
  const state = { assessment, issue: { ...issue }, calls: [], auth: [] };
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    const p = url.replace(/^https?:\/\/[^/]+/, "");
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push({ method, path: p, body });
    state.auth.push(opts.headers?.authorization ?? opts.headers?.Authorization ?? null);

    const doc = /^\/api\/issues\/([^/]+)\/documents\/([^/?]+)$/.exec(p);
    if (doc) {
      const [, issueId, key] = doc;
      if (issueId !== state.issue.id) return { ok: false, status: 403, text: async () => "forbidden" };
      if (method === "GET") {
        return state.assessment
          ? { ok: true, status: 200, text: async () => JSON.stringify(state.assessment) }
          : { ok: false, status: 404, text: async () => JSON.stringify({ error: "Document not found" }) };
      }
      if (method === "PUT") {
        if (state.assessment && body.baseRevisionId !== state.assessment.latestRevisionId) {
          return { ok: false, status: 409, text: async () => JSON.stringify({ error: "Document was updated by someone else" }) };
        }
        const n = state.calls.filter((c) => c.method === "PUT").length;
        state.assessment = {
          key, title: body.title, format: body.format, body: body.body,
          latestRevisionId: `rev-${n}`,
        };
        return { ok: true, status: 200, text: async () => JSON.stringify(state.assessment) };
      }
    }

    const iss = /^\/api\/issues\/([^/?]+)$/.exec(p);
    if (iss) {
      if (iss[1] !== state.issue.id) return { ok: false, status: 403, text: async () => "forbidden" };
      if (method === "GET") return { ok: true, status: 200, text: async () => JSON.stringify(state.issue) };
      if (method === "PATCH") {
        if (!body.comment?.trim()) {
          return { ok: false, status: 422, text: async () => JSON.stringify({ error: "Approving a review or approval stage requires a comment." }) };
        }
        state.issue = { ...state.issue, status: body.status };
        return { ok: true, status: 200, text: async () => JSON.stringify(state.issue) };
      }
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };
  return { state, fetchImpl };
}

const passingExec = () => ({ status: 0, stdout: "2 passed", stderr: "" });
const failingExec = () => ({ status: 1, stdout: "1 failed", stderr: "" });

function call(overrides = {}) {
  const s = overrides.server ?? server();
  const api = new PaperclipApi(ENV.PAPERCLIP_API_URL, {
    fetch: s.fetchImpl, authToken: ENV.PAPERCLIP_API_KEY,
  });
  return {
    s,
    run: (params = {}) => submitReview({
      env: ENV, api, objective: OBJECTIVE,
      reviewerModel: "openai-codex/gpt-5.6-sol",
      engineerModel: "anthropic/claude-opus-5",
      verifierPath: "/factory/ops/omp-verify-bwrap.sh",
      exec: overrides.exec ?? passingExec,
      round: 1,
      executionReceiptHash: "sha256:" + "e".repeat(64),
      changeSet: {
        baseCommit: "3cb8238", headCommit: "3cb8238",
        diffHash: "sha256:" + "d".repeat(64), changedPaths: ["bin/view.py"],
      },
      criteria: [
        { criterionId: "ZEI-1-AC-01", verdict: "PASS", evidenceRefs: ["check:01"], reasoning: "derived independently", uncertainty: null },
        { criterionId: "ZEI-1-AC-02", verdict: "PASS", evidenceRefs: ["check:02"], reasoning: "derived independently", uncertainty: null },
      ],
      summary: "All criteria independently derived and verified.",
      ...params,
    }),
  };
}

test("an approving review writes the assessment then advances the stage with a comment", async () => {
  const { s, run } = call();
  const out = await run();

  assert.equal(out.disposition, "approve");
  assert.equal(out.overallVerdict, "PASS");

  const put = s.state.calls.find((c) => c.method === "PUT");
  assert.equal(put.path, "/api/issues/issue-uuid-1/documents/assessment");
  const patch = s.state.calls.find((c) => c.method === "PATCH");
  assert.equal(patch.path, "/api/issues/issue-uuid-1");
  assert.equal(patch.body.status, "done");
  assert.ok(patch.body.comment.trim(), "a stage decision without a comment is rejected 422");

  // The document must be written BEFORE the transition: a stage that advanced
  // without its evidence in place is an approval nobody can audit.
  assert.ok(s.state.calls.indexOf(put) < s.state.calls.indexOf(patch));
  assert.equal(s.state.issue.status, "done");
});

test("a failing deterministic check requests changes and never approves", async () => {
  const { s, run } = call({ exec: failingExec });
  const out = await run();

  assert.equal(out.disposition, "request_changes");
  const patch = s.state.calls.find((c) => c.method === "PATCH");
  assert.equal(patch.body.status, "in_progress");
  assert.match(patch.body.comment, /deterministic/i);
  assert.equal(s.state.issue.status, "in_progress");
});

test("the reviewer's own PASS cannot override a red deterministic check", async () => {
  // Every criterion asserted PASS by the model, but the commands fail.
  const { run } = call({ exec: failingExec });
  const out = await run();
  assert.equal(out.disposition, "request_changes");
  assert.equal(out.criteria.every((c) => c.verdict === "PASS"), true,
    "the model's verdicts are recorded faithfully...");
  assert.notEqual(out.disposition, "approve", "...but they do not decide the disposition alone");
});

test("every request carries the run's agent token", async () => {
  const { s, run } = call();
  await run();
  assert.ok(s.state.auth.length > 0);
  assert.ok(s.state.auth.every((a) => a === "Bearer agent-jwt-token"),
    "an unauthenticated review write would be rejected by the live server");
});

test("the assessment document is written for the current issue and no other", async () => {
  const { s, run } = call();
  await run();
  const writes = s.state.calls.filter((c) => c.method === "PUT" || c.method === "PATCH");
  assert.ok(writes.length > 0);
  for (const w of writes) {
    assert.match(w.path, /^\/api\/issues\/issue-uuid-1(\/|$)/,
      `write to ${w.path} escapes the current issue`);
  }
});

test("a review by the producer's own model family refuses before writing anything", async () => {
  const { s, run } = call();
  await assert.rejects(
    () => run({ reviewerModel: "anthropic/claude-sonnet-5" }),
    (err) => { assert.ok(err instanceof FactoryError); assert.match(err.message, /same model family/); return true; },
  );
  assert.equal(s.state.calls.filter((c) => c.method !== "GET").length, 0,
    "a refused review must leave no trace on the control plane");
});

test("an incomplete set of criterion verdicts refuses before writing anything", async () => {
  const { s, run } = call();
  await assert.rejects(
    () => run({ criteria: [{ criterionId: "ZEI-1-AC-01", verdict: "PASS", reasoning: "x" }] }),
    /ZEI-1-AC-02/,
  );
  assert.equal(s.state.calls.filter((c) => c.method !== "GET").length, 0);
});

test("a review with no summary refuses, because the stage decision requires a comment", async () => {
  const { run } = call();
  await assert.rejects(() => run({ summary: "   " }), /comment|summary/i);
});

test("the assessment body validates as AssessmentV1", async () => {
  const { s, run } = call();
  await run();
  const put = s.state.calls.find((c) => c.method === "PUT");
  const assessment = JSON.parse(put.body.body);

  const { validateContract } = require("../../lib/contracts");
  assert.doesNotThrow(() => validateContract("AssessmentV1", assessment));
  assert.equal(assessment.objective.objectiveHash, OBJECTIVE.objectiveHash);
  assert.equal(assessment.objective.criteriaHash, OBJECTIVE.criteriaHash);
  assert.equal(assessment.reviewer.modelFamily, "openai-codex");
  assert.equal(assessment.deterministicResults.length, 2);
  assert.equal(assessment.overallVerdict, "PASS");
});

test("an existing assessment is updated under optimistic concurrency", async () => {
  const s = server({ assessment: { key: "assessment", title: "t", format: "markdown", body: "old", latestRevisionId: "rev-7" } });
  const { run } = call({ server: s });
  await run();
  const put = s.state.calls.find((c) => c.method === "PUT");
  assert.equal(put.body.baseRevisionId, "rev-7");
});

test("exhausting the review rounds escalates instead of returning the work again", async () => {
  const { s, run } = call({ exec: failingExec });
  const out = await run({ round: 2, limits: { maxReviewRounds: 2 } });

  assert.equal(out.escalated, true);
  const patch = s.state.calls.find((c) => c.method === "PATCH");
  assert.notEqual(patch.body.status, "done", "an exhausted review must not approve");
  assert.match(patch.body.comment, /escalat/i,
    "the comment must say the budget is exhausted, so the human knows why it arrived");
});

test("a write the server accepts but does not persist fails the review rather than passing it", async () => {
  const s = server();
  const original = s.fetchImpl;
  const stale = { key: "assessment", title: "t", format: "markdown", body: "STALE", latestRevisionId: "rev-0" };
  const lying = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    // Accepts the write, reports 200, and serves the OLD content forever.
    if (/documents/.test(url)) {
      if (method === "PUT") return { ok: true, status: 200, text: async () => JSON.stringify(stale) };
      return { ok: true, status: 200, text: async () => JSON.stringify(stale) };
    }
    return original(url, opts);
  };
  const api = new PaperclipApi(ENV.PAPERCLIP_API_URL, { fetch: lying, authToken: ENV.PAPERCLIP_API_KEY });
  await assert.rejects(
    () => submitReview({
      env: ENV, api, objective: OBJECTIVE,
      reviewerModel: "openai-codex/gpt-5.6-sol", engineerModel: "anthropic/claude-opus-5",
      verifierPath: "/v", exec: passingExec, round: 1,
      executionReceiptHash: "sha256:" + "e".repeat(64),
      changeSet: { baseCommit: "3cb8238", headCommit: "3cb8238", diffHash: "sha256:" + "d".repeat(64), changedPaths: ["bin/view.py"] },
      criteria: OBJECTIVE.acceptanceCriteria.map((c) => ({ criterionId: c.id, verdict: "PASS", reasoning: "ok" })),
      summary: "ok",
    }),
    /did not persist/,
  );
  assert.equal(s.state.issue.status, "in_review", "the stage must not advance on an unpersisted assessment");
});
