"use strict";
// The Hermes handoff skill must actually reach the Hermes profile.
//
// THE DEFECT THIS FILE PINS. lib/materialize.js copied exactly three Hermes
// files — config.yaml, SOUL.md, memories/USER.md — while factory.config.json
// declared a `skills` toolset "to load paperclip-engineer-handoff". The skill
// was never installed anywhere Hermes looks, so the one action the Hermes role
// exists to perform was undeliverable: it could investigate and clarify, then
// had no sanctioned way to hand work to an Engineer.
//
// WHERE HERMES ACTUALLY LOOKS. $HERMES_HOME/skills/<name>/SKILL.md
// (hermes-agent tools/skills_tool.py:144 — `SKILLS_DIR = HERMES_HOME /
// "skills"`), and ops/hermes-bwrap.sh:188 pins HERMES_HOME to the profile
// directory. So the destination is the profile's own skills/ tree, and these
// tests assert that exact path rather than merely "some file was copied".

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const materialize = require("../../lib/materialize");

const ROOT = path.resolve(__dirname, "../..");
const SKILL_TEMPLATE = "skills/paperclip-engineer-handoff/SKILL.md";
const SKILL_DEST = "profiles/paperclip-hermes/skills/paperclip-engineer-handoff/SKILL.md";

function withRoots(fn) {
  return async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-skill-"));
    const prev = {
      FACTORY_OMP_ROOT: process.env.FACTORY_OMP_ROOT,
      FACTORY_HERMES_ROOT: process.env.FACTORY_HERMES_ROOT,
      FACTORY_TEMPLATE_ROOT: process.env.FACTORY_TEMPLATE_ROOT,
    };
    process.env.FACTORY_OMP_ROOT = path.join(base, "omp");
    process.env.FACTORY_HERMES_ROOT = path.join(base, "hermes");
    process.env.FACTORY_TEMPLATE_ROOT = ROOT;
    t.after(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(base, { recursive: true, force: true });
    });
    return fn({ hermesRoot: path.join(base, "hermes") });
  };
}

test("plan installs the handoff skill into the Hermes profile skills tree",
  withRoots(async ({ hermesRoot }) => {
    const planned = materialize.plan({});
    const target = planned.targets.find((t) => t.template === SKILL_TEMPLATE);

    assert.ok(target, `no target materializes ${SKILL_TEMPLATE}`);
    assert.equal(target.path, path.join(hermesRoot, SKILL_DEST));
    assert.equal(target.action, "create");
  }));

test("apply writes the skill byte-identical to the committed template",
  withRoots(async ({ hermesRoot }) => {
    materialize.run({}, { apply: true });

    const written = fs.readFileSync(path.join(hermesRoot, SKILL_DEST), "utf8");
    assert.equal(written, fs.readFileSync(path.join(ROOT, SKILL_TEMPLATE), "utf8"));
  }));

test("the materialized profile carries exactly one skill and no bundled extras",
  withRoots(async ({ hermesRoot }) => {
    materialize.run({}, { apply: true });

    const skillsDir = path.join(hermesRoot, "profiles/paperclip-hermes/skills");
    assert.deepEqual(fs.readdirSync(skillsDir), ["paperclip-engineer-handoff"]);
  }));

test("the skill invokes factory by absolute path, because factory is not on PATH", () => {
  // Hermes runs from a neutral non-repository cwd
  // (factory.config.json adapterConfig.cwd), and `factory` is not installed
  // globally — `which factory` finds nothing on this machine. A bare `factory
  // handoff` in the skill would fail at the shell, after the model had already
  // composed a correct draft.
  const skill = fs.readFileSync(path.join(ROOT, SKILL_TEMPLATE), "utf8");
  const invocation = skill.match(/^\s*(\S*factory) handoff --draft/m);

  assert.ok(invocation, "the skill documents no `factory handoff --draft` invocation");
  assert.ok(path.isAbsolute(invocation[1]),
    `the skill invokes ${JSON.stringify(invocation[1])}, which is not an absolute path`);
  assert.ok(fs.existsSync(invocation[1]),
    `the skill invokes ${invocation[1]}, which does not exist on this machine`);
  fs.accessSync(invocation[1], fs.constants.X_OK);
});

test("the profile disables project-local skill discovery", () => {
  // Hermes also loads skills from `<git root>/.hermes/skills` and
  // `<git root>/.agents/skills` when its cwd sits inside a trusted checkout
  // (agent/skill_utils.py get_project_skills_dirs). Today that yields nothing,
  // because adapterConfig.cwd is a neutral non-git directory — but that makes
  // the protection a property of one config value in a different file. The
  // config key states it where the profile is defined, so moving the cwd into
  // a repository cannot silently hand Hermes that repository's skills.
  const config = fs.readFileSync(
    path.join(ROOT, "hermes/profiles/paperclip-hermes/config.yaml"), "utf8");
  const skillsBlock = config.match(/^skills:\n((?:[ \t][^\n]*\n?)*)/m)?.[1] ?? "";

  assert.match(skillsBlock, /^\s+project_discovery:\s*false\s*$/m,
    "the profile does not pin skills.project_discovery: false");
});
