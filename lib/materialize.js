"use strict";
// `factory materialize` — idempotent materialization of repository profile
// templates into the agent state roots.
//
// WHAT IT OWNS
//   The mapping from repository templates (omp/profiles/**,
//   hermes/profiles/**) to the state roots the adapters actually compute:
//   ~/.omp/profiles/<name>/agent/config.yml for OMP (the omp_local adapter's
//   profile state root) and ~/.hermes/profiles/<name>/** for Hermes (a whole
//   HERMES_HOME). omp/base.overlay.yml is NOT materialized — it stays in the
//   repository, referenced by adapterConfig.configFiles — but plan() asserts
//   it exists and is readable, because every factory OMP run loads it.
//
// WHAT IT MUST NEVER DO
//   Write outside the resolved profile roots, clobber an operator-modified
//   destination, carry a credential, or make a network call. `--check` is
//   byte-read-only: zero writes, zero network. Refusals are FactoryError,
//   never silent skips.
//
// ROOT OVERRIDES
//   FACTORY_OMP_ROOT and FACTORY_HERMES_ROOT redirect the destination roots,
//   and FACTORY_TEMPLATE_ROOT redirects the template source tree. They exist
//   so tests can run against temp directories; they default to the real
//   roots. Nothing else in this module reads the environment.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FactoryError, hashText } = require("./util");

/** Template root: the repository this CLI ships from, unless redirected. */
function templateRoot() {
  return process.env.FACTORY_TEMPLATE_ROOT
    ? path.resolve(process.env.FACTORY_TEMPLATE_ROOT)
    : path.resolve(__dirname, "..");
}

function ompRoot() {
  return process.env.FACTORY_OMP_ROOT
    ? path.resolve(process.env.FACTORY_OMP_ROOT)
    : path.join(os.homedir(), ".omp");
}

function hermesRoot() {
  return process.env.FACTORY_HERMES_ROOT
    ? path.resolve(process.env.FACTORY_HERMES_ROOT)
    : path.join(os.homedir(), ".hermes");
}

// The destination map. OMP profiles materialize INTO the profile's agent dir
// (the adapter's real state root); the Hermes profile is a whole HERMES_HOME,
// so its files keep their relative layout (memories/USER.md included —
// hermes reads the user profile from $HERMES_HOME/memories/USER.md).
const OMP_PROFILES = ["paperclip-engineer", "paperclip-reviewer"];
const HERMES_PROFILE = "paperclip-hermes";
const HERMES_FILES = ["config.yaml", "SOUL.md", "memories/USER.md"];
const OVERLAY = "omp/base.overlay.yml";

// Skills the Hermes profile carries, as [repository template, path within the
// profile]. They are listed separately from HERMES_FILES because their source
// is the repository's own skills/ tree — the canonical copy, shared with any
// other consumer — rather than a file that exists only to be materialized.
//
// The destination is load-bearing: hermes resolves skills from
// $HERMES_HOME/skills (hermes-agent tools/skills_tool.py:144) and
// ops/hermes-bwrap.sh pins HERMES_HOME to this profile, so a skill anywhere
// else is invisible to the agent. This was the whole defect: the profile
// declared a `skills` toolset for a skill nothing ever installed.
const HERMES_SKILLS = [
  ["skills/paperclip-engineer-handoff/SKILL.md", "skills/paperclip-engineer-handoff/SKILL.md"],
];
const PROFILE_MODE = 0o600; // agent state roots: owner read/write only.

/** Every template->destination pair, in stable order. */
function targets() {
  const out = [];
  for (const profile of OMP_PROFILES) {
    out.push({
      template: `omp/profiles/${profile}/config.yml`,
      dest: path.join(ompRoot(), "profiles", profile, "agent", "config.yml"),
      root: ompRoot(),
      mode: PROFILE_MODE,
    });
  }
  for (const file of HERMES_FILES) {
    out.push({
      template: `hermes/profiles/${HERMES_PROFILE}/${file}`,
      dest: path.join(hermesRoot(), "profiles", HERMES_PROFILE, file),
      root: hermesRoot(),
      mode: PROFILE_MODE,
    });
  }
  for (const [template, within] of HERMES_SKILLS) {
    out.push({
      template,
      dest: path.join(hermesRoot(), "profiles", HERMES_PROFILE, within),
      root: hermesRoot(),
      mode: PROFILE_MODE,
    });
  }
  return out;
}

// ------------------------------------------------------------- secret guard
// A template is REPOSITORY CONTENT: it is reviewed like code and shipped to
// every environment. A credential in a template is a reviewed, committed,
// distributed secret. The guard runs on every plan(), against every template,
// so a pasted key fails loudly at planning time rather than living silently
// in git history.
const SECRET_PATTERNS = [
  { name: "OpenAI-style key (sk-…)", re: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: "GitHub token (ghp_/gho_/ghu_/ghs_/ghr_…)", re: /gh[posur]_[A-Za-z0-9]{16,}/ },
  { name: "bearer credential", re: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: "private key block", re: /PRIVATE KEY/ },
  { name: "api_key with a value", re: /api[_-]?key\s*["'`]*\s*[:=]\s*["'`]?[^\s"'`]{8,}/i },
  { name: "token with a value", re: /token\s*["'`]*\s*[:=]\s*["'`]?[A-Za-z0-9._-]{12,}/i },
  // A long undelimited base64/hex run: no legitimate template line is 40+
  // contiguous base64 or 32+ contiguous hex characters.
  { name: "long base64 run", re: /[A-Za-z0-9+/]{40,}={0,2}/ },
  { name: "long hex run", re: /(?:^|[^0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/ },
];

/** Throw if bytes look like they contain a credential. */
function assertNoSecrets(bytes, name) {
  const text = bytes.toString("utf8");
  for (const { name: what, re } of SECRET_PATTERNS) {
    const hit = text.match(re);
    if (hit) {
      throw new FactoryError(
        `template ${name} matches secret-shaped pattern "${what}" ` +
          `(${JSON.stringify(hit[0].slice(0, 24))}…); repository templates must never contain credentials`,
        { template: name, pattern: what },
      );
    }
  }
}

// --------------------------------------------------------- path containment
/**
 * The destination must live inside its resolved root, including through
 * symlinks: walk from the root down the destination's segments, realpath-ing
 * every component that exists, and refuse the moment a resolved path escapes.
 * Non-existent tail segments cannot yet be symlinks; apply() creates parents
 * level by level under the same guarantee (mkdir only descends within the
 * already-checked prefix).
 */
function assertContainment(root, dest, what) {
  const rootAbs = path.resolve(root);
  const destAbs = path.resolve(dest);
  if (destAbs !== rootAbs && !destAbs.startsWith(rootAbs + path.sep)) {
    throw new FactoryError(
      `refusing to write outside the profile root: ${what} (${destAbs} is not under ${rootAbs})`,
    );
  }
  if (!fs.existsSync(rootAbs)) return; // nothing under it can exist yet
  const rootReal = fs.realpathSync(rootAbs);
  let cur = rootAbs;
  for (const seg of path.relative(rootAbs, destAbs).split(path.sep)) {
    if (seg === "" || seg === ".") continue;
    cur = path.join(cur, seg);
    if (!fs.existsSync(cur)) break; // uncreated tail
    const real = fs.realpathSync(cur);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new FactoryError(
        `refusing to write outside the profile root: ${what} (${cur} resolves to ${real}, outside ${rootReal})`,
      );
    }
  }
}

// ------------------------------------------------------------------ reading
function readTemplate(templateRootDir, template) {
  const abs = path.join(templateRootDir, template);
  let bytes;
  try {
    bytes = fs.readFileSync(abs);
  } catch (err) {
    throw new FactoryError(`cannot read template ${template}: ${err.message}`, { template });
  }
  assertNoSecrets(bytes, template);
  return bytes;
}

/**
 * plan(cfg) -> { targets: [{ template, path, mode, action, reason }], ok }
 *
 * Byte-read-only: zero writes, zero network. Compares content hashes with
 * hashText from lib/util.js and reports per-target create/update/ok.
 * `ok` is true only when every target is already byte-identical to its
 * template. `cfg` is the loaded factory config; the destination roots come
 * from the environment overrides documented in the header, never from cfg,
 * so tests can redirect destinations without forging a config.
 */
function plan(cfg) {
  void cfg;
  const root = templateRoot();

  // The overlay is repo-resident, not materialized — but every factory OMP
  // run loads it through adapterConfig.configFiles, so it must exist and be
  // readable. A deleted or unreadable overlay is a hard planning error, not
  // a silent routing change.
  readTemplate(root, OVERLAY);

  const out = [];
  for (const t of targets()) {
    const bytes = readTemplate(root, t.template);
    assertContainment(t.root, t.dest, t.template);
    let action;
    let reason;
    if (!fs.existsSync(t.dest)) {
      action = "create";
      reason = "destination missing";
    } else if (hashText(fs.readFileSync(t.dest).toString("utf8")) === hashText(bytes.toString("utf8"))) {
      action = "ok";
      reason = "destination matches template";
    } else {
      action = "update";
      reason = "destination differs from template";
    }
    out.push({ template: t.template, path: t.dest, mode: t.mode, action, reason });
  }
  return { targets: out, ok: out.every((x) => x.action === "ok") };
}

// ------------------------------------------------------------------- record
// A per-root record of what the materializer last wrote, so "the previous
// template" is knowable without git: an update over content the materializer
// itself produced is a routine refresh; an update over anything else is an
// operator modification and is refused without --force.
function recordPath(root) {
  return path.join(root, ".factory-materialized.json");
}

function loadRecord(root) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(root), "utf8"));
  } catch {
    return {};
  }
}

function writeRecord(root, entries) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, `.factory-materialized.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, recordPath(root));
}

// -------------------------------------------------------------------- apply
function atomicWrite(dest, bytes, mode) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, bytes, { mode });
  fs.renameSync(tmp, dest);
}

function apply(cfg, { force }) {
  const specs = targets();
  const planned = plan(cfg);
  const byDest = new Map(specs.map((t) => [t.dest, t]));
  const roots = [...new Set(specs.map((t) => t.root))];
  const applied = new Map();

  for (const root of roots) {
    const record = loadRecord(root);
    for (const target of planned.targets) {
      const spec = byDest.get(target.path);
      if (!spec || spec.root !== root) continue;
      if (target.action === "ok") continue;
      if (fs.existsSync(target.path)) {
        const currentHash = hashText(fs.readFileSync(target.path).toString("utf8"));
        const materializedBefore = record[target.path] === currentHash;
        if (!materializedBefore && !force) {
          throw new FactoryError(
            `refusing to overwrite operator-modified destination ${target.path}; pass --force to clobber it`,
            { path: target.path },
          );
        }
      }
      const bytes = readTemplate(templateRoot(), spec.template);
      assertContainment(spec.root, target.path, spec.template);
      atomicWrite(target.path, bytes, spec.mode);
      applied.set(target.path, hashText(bytes.toString("utf8")));
    }
  }

  for (const root of roots) {
    const record = loadRecord(root);
    let changed = false;
    for (const [dest, hash] of applied) {
      const spec = byDest.get(dest);
      if (!spec || spec.root !== root) continue;
      if (record[dest] !== hash) {
        record[dest] = hash;
        changed = true;
      }
    }
    if (changed) writeRecord(root, record);
  }

  return { mode: "apply", targets: planned.targets, ok: true, written: applied.size };
}

// ---------------------------------------------------------------------- run
/**
 * run(cfg, args) — `factory materialize --check` | `factory materialize
 * --apply [--force]`. `args` is either a CLI-style array of strings or an
 * options object ({ check, apply, force }). Returns { mode, targets, ok,
 * written? } for the caller to render; refusals throw FactoryError with the
 * exact offending path. `--check` never writes and never touches the network;
 * with no flags it is the default, because read-only is the safe default.
 */
function run(cfg, args) {
  let check = false;
  let applyFlag = false;
  let force = false;
  if (Array.isArray(args)) {
    for (const a of args) {
      if (a === "--check") check = true;
      else if (a === "--apply") applyFlag = true;
      else if (a === "--force") force = true;
      else throw new FactoryError(`materialize: unknown argument ${JSON.stringify(a)}`);
    }
  } else if (args && typeof args === "object") {
    // bin/factory hands over its parseArgs output ({ _: [...], flags: {...} });
    // plain options objects ({ check, apply, force }) are accepted too, which
    // keeps the unit tests free of the CLI shape.
    const flags = args.flags && typeof args.flags === "object" ? args.flags : args;
    check = flags.check === true;
    applyFlag = flags.apply === true;
    force = flags.force === true;
  } else if (args !== undefined) {
    throw new FactoryError("materialize: args must be an argv array or an options object");
  }
  if (check && applyFlag) throw new FactoryError("materialize: --check and --apply are mutually exclusive");
  if (force && !applyFlag) throw new FactoryError("materialize: --force requires --apply");
  if (!check && !applyFlag) check = true;

  if (check) {
    const planned = plan(cfg);
    return { mode: "check", targets: planned.targets, ok: planned.ok };
  }
  return apply(cfg, { force });
}

module.exports = { plan, run, assertNoSecrets };
