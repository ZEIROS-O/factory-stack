"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { validateContract, NAMES } = require("../../lib/contracts");

const SCHEMA_DIR = path.resolve(__dirname, "../../contracts/schemas");
const HANDOFF_NAMES = [
  "EngineerHandoffDraftV1",
  "EngineerHandoffReceiptV1",
  "EngineerGoalGateV1",
];
const HASH = `sha256:${"a".repeat(64)}`;
const BARE_DIGEST = "a".repeat(64);

const schemas = {};
for (const name of HANDOFF_NAMES) {
  schemas[name] = require(path.join(SCHEMA_DIR, `${name}.schema.json`));
}

// --- fixture builders -------------------------------------------------------

function validDraft() {
  return {
    schemaVersion: "EngineerHandoffDraftV1",
    parentIssueIdentifier: "ZEI-1",
    idempotencyKey: "handoff-zei-1-001",
    title: "Implement the widget parser",
    originalRequest: "Parse widget files without external dependencies.",
    repository: {
      path: "/home/lucascoh/worktrees/factory-context-arch",
      baseCommit: "3cb8238",
    },
    permissions: {
      filesystem: { read: ["contracts/"], write: ["lib/"] },
      network: "none",
      externalEffects: [],
    },
    limits: {
      wallClockMinutes: 45,
      costCeilingUsd: 4,
      outerFactoryCostCeilingUsd: 5,
      maxReviewRounds: 2,
    },
    verificationLevel: "important",
    expectedOutputs: ["lib/parser.js"],
    constraints: ["Node 22 CommonJS only."],
    acceptanceCommands: [
      {
        requirement: "Parser unit tests pass.",
        command: { argv: ["node", "--test", "test/unit/parser.test.js"], cwd: "." },
      },
    ],
  };
}

function validReceipt() {
  return {
    schemaVersion: "EngineerHandoffReceiptV1",
    parentIssueId: "issue-parent-1",
    parentIssueIdentifier: "ZEI-1",
    childIssueId: "issue-child-1",
    childIssueIdentifier: "ZEI-2",
    idempotencyKey: "handoff-zei-1-001",
    objectiveId: "objective-1",
    revision: 1,
    objectiveHash: HASH,
    criteriaHash: HASH,
    specRevisionId: "spec-rev-1",
    activation: { assignedAgent: "omp-engineer", status: "runnable", blocksParent: true },
    readback: { verified: true, documentBodyHash: HASH, checkedAt: "2026-09-02T12:00:00Z" },
  };
}

function validGate() {
  return {
    schemaVersion: "EngineerGoalGateV1",
    runId: "run-1",
    taskId: "issue-child-1",
    sessionId: "session-1",
    goalId: "goal-1",
    goalObjectiveHash: HASH,
    objectiveId: "objective-1",
    revision: 1,
    objectiveHash: HASH,
    criteriaHash: HASH,
    goalStatus: "complete",
    continuations: 0,
    terminal: true,
    observedAt: "2026-09-02T12:30:00Z",
  };
}

const fixtures = {
  EngineerHandoffDraftV1: validDraft,
  EngineerHandoffReceiptV1: validReceipt,
  EngineerGoalGateV1: validGate,
};

// --- schema-driven helpers --------------------------------------------------

function pointer(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`unsupported ref ${ref}`);
  }
  let cur = root;
  for (const seg of ref.slice(2).split("/")) {
    cur = cur[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur;
}

function deref(schema, root) {
  if (schema && typeof schema === "object" && typeof schema.$ref === "string") {
    return deref(pointer(root, schema.$ref), root);
  }
  return schema;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getAt(value, segs) {
  let cur = value;
  for (const seg of segs) cur = cur[seg];
  return cur;
}

function deleteAt(value, segs) {
  const out = clone(value);
  const parent = getAt(out, segs.slice(0, -1));
  delete parent[segs[segs.length - 1]];
  return out;
}

function setAt(value, segs, replacement) {
  const out = clone(value);
  const parent = getAt(out, segs.slice(0, -1));
  parent[segs[segs.length - 1]] = replacement;
  return out;
}

// Walk a schema against a valid instance and return one broken instance per
// `required` key (top level, nested objects, array items), so the test cannot
// drift from the schema's own required arrays.
function requiredRemovalCases(schema, root, value, segs) {
  const s = deref(schema, root);
  const cases = [];
  if (!s) return cases;
  const here = segs.length === 0 ? value : getAt(value, segs);
  if (
    s.type === "object" &&
    Array.isArray(s.required) &&
    here && typeof here === "object" && !Array.isArray(here)
  ) {
    for (const key of s.required) {
      cases.push({ label: segs.concat(key).join("."), broken: deleteAt(value, segs.concat(key)) });
    }
    for (const [key, sub] of Object.entries(s.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(here, key)) {
        cases.push(...requiredRemovalCases(sub, root, value, segs.concat(key)));
      }
    }
  }
  if (s.type === "array" && s.items && Array.isArray(here) && here.length > 0) {
    cases.push(...requiredRemovalCases(s.items, root, value, segs.concat(0)));
  }
  return cases;
}

// Walk a schema and return the instance paths of every property bound to the
// hash definition, so every hash field is exercised without hand-listing it.
function hashPaths(schema, root, segs) {
  const s = deref(schema, root);
  if (!s) return [];
  let out = [];
  if (s === root.definitions.hash) out.push(segs);
  if (s.type === "object" && s.properties) {
    for (const [key, sub] of Object.entries(s.properties)) {
      out = out.concat(hashPaths(sub, root, segs.concat(key)));
    }
  }
  return out;
}

function expectInvalid(name, broken, label) {
  assert.throws(
    () => validateContract(name, broken),
    /validation failed/,
    `${name}: expected invalid instance (${label})`
  );
}

// --- registration -----------------------------------------------------------

test("lib/contracts registers all three handoff schemas alongside the existing three", () => {
  assert.deepEqual(
    NAMES.filter((n) => HANDOFF_NAMES.includes(n)).sort(),
    [...HANDOFF_NAMES].sort()
  );
  assert.deepEqual(NAMES.slice(0, 3), [
    "ObjectiveEnvelopeV1",
    "ExecutionReceiptV1",
    "AssessmentV1",
  ]);
  for (const name of HANDOFF_NAMES) {
    assert.doesNotThrow(() => validateContract(name, fixtures[name]()));
  }
});

// --- per-schema: valid, required, extra keys, hash fields --------------------

for (const name of HANDOFF_NAMES) {
  test(`${name} validates a minimal instance containing only required keys`, () => {
    const value = fixtures[name]();
    assert.equal(validateContract(name, value), value);
  });

  test(`${name} rejects each required property removed one at a time`, () => {
    const schema = schemas[name];
    const cases = requiredRemovalCases(schema, schema, fixtures[name](), []);
    assert.ok(cases.length > 0, `${name}: schema walk found no required keys`);
    for (const c of cases) expectInvalid(name, c.broken, `missing ${c.label}`);
  });

  test(`${name} rejects an unknown top-level key`, () => {
    const broken = fixtures[name]();
    broken.unexpectedExtraKey = "surprise";
    assert.throws(() => validateContract(name, broken), /additional properties/);
  });

  test(`${name} rejects a bare 64-hex digest in every hash field`, () => {
    const schema = schemas[name];
    const paths = hashPaths(schema, schema, []);
    for (const segs of paths) {
      expectInvalid(name, setAt(fixtures[name](), segs, BARE_DIGEST), `${segs.join(".")} bare digest`);
    }
  });
}

// --- EngineerHandoffDraftV1 guards ------------------------------------------

test("EngineerHandoffDraftV1 rejects a shell-string acceptance command", () => {
  const broken = validDraft();
  broken.acceptanceCommands[0].command = "node --test test/unit/parser.test.js";
  assert.throws(() => validateContract("EngineerHandoffDraftV1", broken), /acceptanceCommands/);
});

test("EngineerHandoffDraftV1 rejects an authored criterion id", () => {
  const broken = validDraft();
  broken.acceptanceCommands[0].id = "ZEI-2-AC-01";
  assert.throws(() => validateContract("EngineerHandoffDraftV1", broken), /additional properties/);
});

test("EngineerHandoffDraftV1 rejects every derived identifier at the top level", () => {
  for (const key of [
    "childIssueIdentifier",
    "branch",
    "objectiveId",
    "revision",
    "objectiveHash",
    "criteriaHash",
  ]) {
    const broken = validDraft();
    broken[key] = key === "revision" ? 1 : "derived-value";
    assert.throws(
      () => validateContract("EngineerHandoffDraftV1", broken),
      /additional properties/,
      `derived key ${key} must be rejected`
    );
  }
});

test("EngineerHandoffDraftV1 rejects a non-empty permissions.externalEffects", () => {
  const broken = validDraft();
  broken.permissions.externalEffects = ["send an email on completion"];
  assert.throws(() => validateContract("EngineerHandoffDraftV1", broken), /externalEffects/);
});

// --- EngineerHandoffReceiptV1 guards ----------------------------------------

test("EngineerHandoffReceiptV1 rejects an activation state other than runnable", () => {
  const broken = validReceipt();
  broken.activation.status = "backlog";
  assert.throws(() => validateContract("EngineerHandoffReceiptV1", broken), /status/);
});

test("EngineerHandoffReceiptV1 rejects a child that does not block the parent", () => {
  const broken = validReceipt();
  broken.activation.blocksParent = false;
  assert.throws(() => validateContract("EngineerHandoffReceiptV1", broken), /blocksParent/);
});

test("EngineerHandoffReceiptV1 rejects an unverified readback", () => {
  const broken = validReceipt();
  broken.readback.verified = false;
  assert.throws(() => validateContract("EngineerHandoffReceiptV1", broken), /verified/);
});

// --- EngineerGoalGateV1 guards ---------------------------------------------

test("EngineerGoalGateV1 rejects a goalStatus outside the native OMP GoalStatus set", () => {
  const broken = validGate();
  broken.goalStatus = "expired";
  assert.throws(() => validateContract("EngineerGoalGateV1", broken), /goalStatus/);
});

test("EngineerGoalGateV1 rejects a negative continuation count", () => {
  const broken = validGate();
  broken.continuations = -1;
  assert.throws(() => validateContract("EngineerGoalGateV1", broken), /continuations/);
});

test("EngineerGoalGateV1 rejects a non-boolean terminal flag", () => {
  const broken = validGate();
  broken.terminal = "true";
  assert.throws(() => validateContract("EngineerGoalGateV1", broken), /terminal/);
});
