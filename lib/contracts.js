"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { clone, hashText, hashValue, FactoryError } = require("./util");

const SCHEMA_DIR = path.resolve(__dirname, "../contracts/schemas");
const NAMES = ["ObjectiveEnvelopeV1", "ExecutionReceiptV1", "AssessmentV1"];
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = {};

for (const name of NAMES) {
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.schema.json`), "utf8"));
  validators[name] = ajv.compile(schema);
}

function validateContract(name, value) {
  const validator = validators[name];
  if (!validator) throw new FactoryError(`unknown contract schema ${name}`);
  if (!validator(value)) {
    const errors = validator.errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw new FactoryError(`${name} validation failed: ${errors}`, { errors: clone(validator.errors) });
  }
  return value;
}

function loadContract(file, expectedName) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) { throw new FactoryError(`cannot load contract ${file}: ${err.message}`); }
  if (value.schemaVersion !== expectedName) {
    throw new FactoryError(`contract ${file} has schemaVersion ${value.schemaVersion}; expected ${expectedName}`);
  }
  return validateContract(expectedName, value);
}

function objectiveCriteriaHash(objective) {
  return hashValue(objective.acceptanceCriteria);
}

function objectiveHash(objective) {
  const hashable = clone(objective);
  delete hashable.objectiveHash;
  return hashValue(hashable);
}

function verifyObjectiveHashes(objective) {
  validateContract("ObjectiveEnvelopeV1", objective);
  const criteria = objectiveCriteriaHash(objective);
  if (objective.criteriaHash !== criteria) {
    throw new FactoryError("ObjectiveEnvelopeV1 criteriaHash does not match acceptanceCriteria", { recorded: objective.criteriaHash, actual: criteria });
  }
  const full = objectiveHash(objective);
  if (objective.objectiveHash !== full) {
    throw new FactoryError("ObjectiveEnvelopeV1 objectiveHash does not match canonical objective", { recorded: objective.objectiveHash, actual: full });
  }
  return objective;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

function renderObjectiveDocument(objective) {
  verifyObjectiveHashes(objective);
  return [
    `# ${objective.objectiveId} immutable objective`, "",
    `Revision: \`${objective.revision}\`  `,
    `Objective hash: \`${objective.objectiveHash}\`  `,
    `Criteria hash: \`${objective.criteriaHash}\``, "",
    "This document is generated from the versioned ObjectiveEnvelopeV1 below. Change requires a new revision and hashes.", "",
    "```json", JSON.stringify(sorted(objective), null, 2), "```", "",
  ].join("\n");
}

/** Read the committed instruction manifest: sha256 -> out/AGENTS.<role>.md. */
function loadInstructionManifest(root) {
  const manifestPath = path.join(root, "instructions", "manifest.sha256");
  let text;
  try { text = fs.readFileSync(manifestPath, "utf8"); }
  catch (err) { throw new FactoryError(`cannot read instruction manifest ${manifestPath}: ${err.message}`); }
  const entries = {};
  for (const line of text.trim().split("\n")) {
    if (!line) continue;
    const m = /^([0-9a-f]{64})\s\s*(\S+)$/.exec(line);
    if (!m) throw new FactoryError(`instruction manifest has a malformed line: ${JSON.stringify(line)}`);
    if (entries[m[2]]) throw new FactoryError(`instruction manifest lists ${m[2]} twice`);
    entries[m[2]] = `sha256:${m[1]}`;
  }
  return entries;
}

/** Bind an agent to its compiled bundle, verified against the committed manifest. */
function hydrateAgentInstructions(agent, root, manifest) {
  const declared = agent.instructions;
  const bundle = declared.bundle;
  if (!bundle || typeof bundle !== "string") {
    throw new FactoryError(`agent ${agent.name}: instructions must declare a bundle role`);
  }
  // The role becomes a filesystem path (out/AGENTS.<role>.md) and a manifest key.
  // Fail closed on anything that is not a plain lowercase role name — a value
  // like "../x" would otherwise read outside the instructions directory.
  if (!/^[a-z][a-z0-9-]*$/.test(bundle)) {
    throw new FactoryError(
      `agent ${agent.name}: instructions.bundle must be a plain role name (lowercase letters, digits, hyphens); got ${JSON.stringify(bundle)}`,
      { bundle },
    );
  }
  const rel = `out/AGENTS.${bundle}.md`;
  const file = path.join(root, "instructions", rel);
  let content;
  try { content = fs.readFileSync(file, "utf8"); }
  catch (err) { throw new FactoryError(`cannot read compiled bundle ${file}: ${err.message}`); }
  const expected = manifest[rel];
  if (!expected) {
    throw new FactoryError(`instruction manifest has no entry for ${rel} (agent ${agent.name})`, { manifest: "instructions/manifest.sha256" });
  }
  const actual = hashText(content);
  if (expected !== actual) {
    throw new FactoryError(`compiled bundle ${rel} does not match the committed manifest`, { file: rel, manifest: expected, actual });
  }
  agent.instructions = { ...declared, content, sha256: actual };
}

function hydrateDeclaredContracts(cfg, root = path.resolve(__dirname, "..")) {
  const manifest = loadInstructionManifest(root);
  for (const agent of cfg.agents ?? []) {
    if (agent.instructions) hydrateAgentInstructions(agent, root, manifest);
  }
  for (const issue of cfg.issues ?? []) {
    const declared = issue.objectiveDocument;
    if (!declared?.sourceFile) continue;
    const sourceFile = path.isAbsolute(declared.sourceFile)
      ? declared.sourceFile
      : path.join(root, declared.sourceFile);
    const objective = verifyObjectiveHashes(loadContract(sourceFile, "ObjectiveEnvelopeV1"));
    if (objective.issueIdentifier !== issue.identifier) {
      throw new FactoryError(`objective ${objective.objectiveId} belongs to ${objective.issueIdentifier}, not ${issue.identifier}`);
    }
    const body = renderObjectiveDocument(objective);
    issue.objectiveDocument = { ...declared, sourceFile, body, bodyHash: hashText(body), objective };
  }
  return cfg;
}

module.exports = {
  NAMES, validateContract, loadContract, objectiveCriteriaHash, objectiveHash,
  verifyObjectiveHashes, renderObjectiveDocument, hydrateDeclaredContracts,
};
