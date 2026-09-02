"use strict";
// Load, expand, and validate factory.config.json.
//
// `$comment` keys carry the reasoning for every non-obvious value and are
// stripped before anything is hashed or compared, so editing a comment never
// changes a plan hash.

const fs = require("node:fs");
const path = require("node:path");
const { FactoryError } = require("./util");
const { hydrateDeclaredContracts } = require("./contracts");

/** Repo root of the running CLI — the tree this file lives in, not the cwd. */
function factoryRoot() {
  return path.resolve(__dirname, "..");
}

function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Any `$comment`-PREFIXED key, not just the bare one. The config documents
      // individual fields with suffixed keys ($comment_maxReviewRounds,
      // $comment_responsibleUser, $comment_objectiveDocument, ...). An exact
      // match let those survive into desired state, and `executionPolicy` — the
      // one object sent to the server wholesale rather than field by field —
      // therefore shipped its own documentation in the payload. The server drops
      // unknown keys and answers 200, so readback could never match and the
      // policy sat in permanent, unfixable drift.
      if (k === "$comment" || k.startsWith("$comment_")) continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return value;
}

function expandVars(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_]+)\}/g, (m, name) => {
      if (!(name in vars)) throw new FactoryError(`unknown variable ${m} in config`);
      return vars[name];
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandVars(v, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandVars(v, vars);
    return out;
  }
  return value;
}

const REQUIRED_TOP = ["version", "api", "pins", "instance", "company", "projects", "agents", "issues", "operator"];

function validate(cfg) {
  for (const key of REQUIRED_TOP) {
    if (cfg[key] === undefined) throw new FactoryError(`factory config missing required key: ${key}`);
  }
  if (cfg.version !== 1) throw new FactoryError(`unsupported config version ${cfg.version}`);

  // A UUID anywhere in the config defeats the whole point of name resolution:
  // it survives a rebuilt instance as a stale pointer instead of failing loudly.
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const walk = (v, at) => {
    if (typeof v === "string" && uuid.test(v)) {
      throw new FactoryError(`config contains a hardcoded database UUID at ${at}; resolve by name instead`, { value: v });
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
  };
  walk(cfg, "config");

  for (const issue of cfg.issues) {
    const strat = issue.executionWorkspaceSettings?.workspaceStrategy;
    if (strat && strat.type === "git_worktree") {
      // The atomic-replacement trap, checked at load rather than at dispatch.
      for (const field of ["baseRef", "branchTemplate", "worktreeParentDir"]) {
        if (!strat[field]) {
          throw new FactoryError(
            `issue ${issue.identifier}: workspaceStrategy is partial (missing ${field}). ` +
            `An issue-level strategy REPLACES the project's rather than merging with it ` +
            `(execution-workspace-policy.js:275 uses ??), so every field must be stated.`,
          );
        }
      }
    }
  }
  return cfg;
}

function load(configPath) {
  const file = configPath ?? path.join(factoryRoot(), "factory.config.json");
  if (!fs.existsSync(file)) throw new FactoryError(`factory config not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new FactoryError(`factory config is not valid JSON: ${err.message}`, { file });
  }
  const root = factoryRoot();
  const cfg = hydrateDeclaredContracts(validate(expandVars(stripComments(raw), { FACTORY_ROOT: root })));
  cfg._file = file;
  cfg._root = root;
  return cfg;
}

module.exports = { load, factoryRoot, stripComments, expandVars, validate };
