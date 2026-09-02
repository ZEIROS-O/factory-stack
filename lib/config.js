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
    // A DECLARED WALL-CLOCK LIMIT AND THE OVERRIDE THAT ENFORCES IT MUST AGREE.
    //
    // `limits.wallClockMinutes` is where the bound is written and read by
    // people. It is NOT what bounds the run. The run is bounded by
    // `assigneeAdapterOverrides.adapterConfig`, which the server merges last
    // over the agent's config (heartbeat.js mergeModelProfileAdapterConfig) and
    // applies only while the issue's assignee is the agent being run. Those are
    // two separate hand-written declarations, and nothing checked they matched.
    //
    // The run's own `resultJson.effectiveTimeoutSec` cannot referee this: the
    // server builds it from `agent.adapterConfig` alone
    // (mergeRunStopMetadataForAgent), so it reports the agent-wide default even
    // when the executor used the issue override. It reads like evidence and is
    // not; see test/unit/issue-limits.test.js.
    //
    // So the agreement is enforced here, at load, where both values are visible
    // — the same place and for the same reason as the partial-workspaceStrategy
    // trap below.
    const minutes = issue.limits?.wallClockMinutes;
    const override = issue.assigneeAdapterOverrides?.adapterConfig;
    if (minutes !== undefined) {
      if (!Number.isInteger(minutes) || minutes < 1) {
        throw new FactoryError(
          `issue ${issue.identifier}: limits.wallClockMinutes must be a positive integer ` +
          `number of minutes, got ${JSON.stringify(minutes)}`,
        );
      }
      if (!override) {
        throw new FactoryError(
          `issue ${issue.identifier}: declares limits.wallClockMinutes ${minutes} but no ` +
          `assigneeAdapterOverrides.adapterConfig. The agent's own adapterConfig.timeoutSec is a ` +
          `shared default across every issue that agent runs, so without the override this limit ` +
          `bounds nothing — it is documentation. Declare ` +
          `assigneeAdapterOverrides.adapterConfig { timeoutSec: ${minutes * 60}, maxTime: "${minutes}m" }.`,
        );
      }
      if (override.timeoutSec !== minutes * 60) {
        throw new FactoryError(
          `issue ${issue.identifier}: limits.wallClockMinutes ${minutes} implies ` +
          `assigneeAdapterOverrides.adapterConfig.timeoutSec ${minutes * 60}, but it is ` +
          `${JSON.stringify(override.timeoutSec)}. The declared bound and the enforced bound ` +
          `must be the same number.`,
        );
      }
      if (override.maxTime !== `${minutes}m`) {
        throw new FactoryError(
          `issue ${issue.identifier}: limits.wallClockMinutes ${minutes} implies ` +
          `assigneeAdapterOverrides.adapterConfig.maxTime "${minutes}m", but it is ` +
          `${JSON.stringify(override.maxTime)}. timeoutSec is Paperclip's process deadline and ` +
          `maxTime is OMP's in-session deadline; disagreeing values bound the same run twice, ` +
          `differently.`,
        );
      }
    } else if (override?.timeoutSec !== undefined || override?.maxTime !== undefined) {
      throw new FactoryError(
        `issue ${issue.identifier}: declares an adapter timeout override but no ` +
        `limits.wallClockMinutes. The bound must be stated where it is read, or the config ` +
        `documents a limit it does not have.`,
      );
    }

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
