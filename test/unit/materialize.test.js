"use strict";
// lib/materialize.js — idempotent profile materializer.
//
// Everything runs against temp roots via FACTORY_OMP_ROOT / FACTORY_HERMES_ROOT.
// The template source tree stays the REAL repository except where a test
// explicitly redirects it to a fixture copy (FACTORY_TEMPLATE_ROOT is the
// documented test hook), so the guard test defends the committed templates,
// not just the code, and no test ever mutates a repository file.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const materialize = require("../../lib/materialize");
const { FactoryError } = require("../../lib/util");

const ROOT = path.resolve(__dirname, "../..");

// The stable destination map plan() emits, in order.
const EXPECTED = [
  { template: "omp/profiles/paperclip-engineer/config.yml", root: "omp" },
  { template: "omp/profiles/paperclip-reviewer/config.yml", root: "omp" },
  { template: "hermes/profiles/paperclip-hermes/config.yaml", root: "hermes" },
  { template: "hermes/profiles/paperclip-hermes/SOUL.md", root: "hermes" },
  { template: "hermes/profiles/paperclip-hermes/memories/USER.md", root: "hermes" },
];

const ALL_REPO_TEMPLATES = ["omp/base.overlay.yml", ...EXPECTED.map((e) => e.template)];

function realTemplateBytes(rel) {
  return fs.readFileSync(path.join(ROOT, rel));
}

/** Copy the real template tree into a fresh temp dir. */
function templateFixture() {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "factory-tpl-"));
  for (const rel of ALL_REPO_TEMPLATES) {
    const dest = path.join(fake, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
  return fake;
}

function withRoots(fn) {
  return async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "factory-materialize-"));
    const ompRoot = path.join(base, "omp");
    const hermesRoot = path.join(base, "hermes");
    const prev = {
      omp: process.env.FACTORY_OMP_ROOT,
      hermes: process.env.FACTORY_HERMES_ROOT,
      templates: process.env.FACTORY_TEMPLATE_ROOT,
    };
    process.env.FACTORY_OMP_ROOT = ompRoot;
    process.env.FACTORY_HERMES_ROOT = hermesRoot;
    process.env.FACTORY_TEMPLATE_ROOT = ROOT;
    t.after(() => {
      for (const [k, v] of Object.entries(prev)) {
        const key = k === "omp" ? "FACTORY_OMP_ROOT" : k === "hermes" ? "FACTORY_HERMES_ROOT" : "FACTORY_TEMPLATE_ROOT";
        if (v === undefined) delete process.env[key];
        else process.env[key] = v;
      }
    });
    return fn({ base, ompRoot, hermesRoot });
  };
}

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

test("--check on an empty root reports every target create, exits non-ok, writes nothing", withRoots(({ ompRoot, hermesRoot }) => {
  const res = materialize.run({}, ["--check"]);
  assert.equal(res.mode, "check");
  assert.equal(res.ok, false);
  assert.deepEqual(res.targets.map((t) => t.action), ["create", "create", "create", "create", "create"]);
  assert.deepEqual(res.targets.map((t) => t.template), EXPECTED.map((e) => e.template));
  // Zero writes: neither root may contain anything, not even a directory.
  assert.deepEqual(listTree(ompRoot), []);
  assert.deepEqual(listTree(hermesRoot), []);
  // The default (no flags) is also check.
  assert.equal(materialize.run({}, undefined).mode, "check");
}));

test("--apply creates every target with the right content and mode; a second apply is idempotent down to the mtime", withRoots(() => {
  const res = materialize.run({}, ["--apply"]);
  assert.equal(res.ok, true);
  assert.equal(res.written, 5);

  for (const e of EXPECTED) {
    const target = res.targets.find((t) => t.template === e.template);
    const dest = path.resolve(target.path);
    assert.ok(fs.existsSync(dest), `${e.template} materialized`);
    assert.deepEqual(fs.readFileSync(dest), realTemplateBytes(e.template), `${e.template} bytes match`);
    assert.equal(fs.statSync(dest).mode & 0o777, 0o600, `${e.template} mode 0600`);
  }

  const mtimes = res.targets.map((t) => fs.statSync(t.path).mtimeNs);
  const second = materialize.run({}, ["--apply"]);
  assert.equal(second.ok, true);
  assert.equal(second.written, 0, "second apply writes nothing");
  assert.deepEqual(second.targets.map((t) => t.action), ["ok", "ok", "ok", "ok", "ok"]);
  assert.deepEqual(
    second.targets.map((t) => fs.statSync(t.path).mtimeNs),
    mtimes,
    "second apply must not touch mtimes",
  );
}));

test("an operator-modified destination is refused without --force, with the path in the message", withRoots(({ ompRoot }) => {
  materialize.run({}, ["--apply"]);
  const dest = path.join(ompRoot, "profiles", "paperclip-engineer", "agent", "config.yml");
  fs.writeFileSync(dest, "# operator tweak\n");
  assert.throws(
    () => materialize.run({}, ["--apply"]),
    (err) => err instanceof FactoryError && err.message.includes(dest) && /operator-modified/.test(err.message),
  );
  // --force clobbers it.
  const forced = materialize.run({}, ["--apply", "--force"]);
  assert.equal(forced.ok, true);
  assert.deepEqual(fs.readFileSync(dest), realTemplateBytes("omp/profiles/paperclip-engineer/config.yml"));
  // The record now marks it as materializer-owned: a plain third apply is all ok.
  assert.deepEqual(materialize.run({}, ["--apply"]).targets.map((t) => t.action), ["ok", "ok", "ok", "ok", "ok"]);
}));

test("an update over the materializer's OWN previous output is a routine refresh, not a refusal", withRoots(() => {
  const fake = templateFixture();
  process.env.FACTORY_TEMPLATE_ROOT = fake;
  materialize.run({}, ["--apply"]);
  const dest = path.join(process.env.FACTORY_OMP_ROOT, "profiles", "paperclip-reviewer", "agent", "config.yml");
  // Simulate a template revision: mutate the FIXTURE template, apply again.
  // The destination still holds the previously materialized bytes, so the
  // per-root record proves ownership and apply refreshes without --force.
  const templatePath = path.join(fake, "omp", "profiles", "paperclip-reviewer", "config.yml");
  const orig = fs.readFileSync(templatePath);
  fs.appendFileSync(templatePath, "\n# revised\n");
  try {
    const res = materialize.run({}, ["--apply"]);
    assert.equal(res.ok, true);
    assert.ok(fs.readFileSync(dest).toString().endsWith("# revised\n"));
    assert.deepEqual(materialize.run({}, ["--apply"]).targets.map((t) => t.action), ["ok", "ok", "ok", "ok", "ok"]);
  } finally {
    fs.writeFileSync(templatePath, orig);
  }
}));

test("a destination outside the resolved profile root is refused (path containment)", withRoots(({ hermesRoot, ompRoot }) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "factory-escape-"));

  // Hermes escape: the profile dir is a symlink out of the root.
  fs.mkdirSync(path.join(hermesRoot, "profiles"), { recursive: true });
  fs.symlinkSync(outside, path.join(hermesRoot, "profiles", "paperclip-hermes"), "dir");
  assert.throws(
    () => materialize.run({}, ["--check"]),
    (err) => err instanceof FactoryError && /outside the profile root/.test(err.message),
  );

  // OMP escape: the agent dir inside a profile is a symlink out of the root.
  fs.rmSync(path.join(hermesRoot, "profiles", "paperclip-hermes"));
  fs.mkdirSync(path.join(ompRoot, "profiles", "paperclip-reviewer"), { recursive: true });
  fs.symlinkSync(outside, path.join(ompRoot, "profiles", "paperclip-reviewer", "agent"), "dir");
  assert.throws(
    () => materialize.run({}, ["--check"]),
    (err) => err instanceof FactoryError && /outside the profile root/.test(err.message),
  );
}));

test("a template containing a secret-shaped string is refused by plan", withRoots(() => {
  const fake = templateFixture();
  fs.appendFileSync(
    path.join(fake, "omp", "profiles", "paperclip-engineer", "config.yml"),
    "\nsk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n",
  );
  process.env.FACTORY_TEMPLATE_ROOT = fake;
  assert.throws(
    () => materialize.run({}, ["--check"]),
    (err) => err instanceof FactoryError && /secret-shaped/.test(err.message) && /engineer/.test(err.message),
  );
}));

test("--check makes zero network calls", withRoots(() => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  globalThis.fetch = (...a) => { calls.push(["fetch", a]); throw new Error("network forbidden"); };
  http.request = (...a) => { calls.push(["http.request", a]); throw new Error("network forbidden"); };
  https.request = (...a) => { calls.push(["https.request", a]); throw new Error("network forbidden"); };
  try {
    materialize.run({}, ["--check"]);
    materialize.plan({});
  } finally {
    globalThis.fetch = originalFetch;
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
  }
  assert.deepEqual(calls, [], "--check and plan must never touch the network");
}));

test("repository templates contain no credential-shaped content", withRoots(() => {
  // The real committed templates, put through the same guard plan() runs.
  for (const rel of ALL_REPO_TEMPLATES) {
    assert.doesNotThrow(() => materialize.assertNoSecrets(realTemplateBytes(rel), rel), rel);
  }
  // And plan() with destinations redirected to temp must not refuse on
  // secrets — this asserts the guard passes on the REAL templates wholesale.
  assert.doesNotThrow(() => materialize.plan({}));
}));

test("--force without --apply, and unknown args, are refused", withRoots(() => {
  assert.throws(() => materialize.run({}, ["--force"]), (e) => e instanceof FactoryError);
  assert.throws(() => materialize.run({}, ["--bogus"]), (e) => e instanceof FactoryError);
  assert.throws(() => materialize.run({}, ["--check", "--apply"]), (e) => e instanceof FactoryError);
}));
test("run accepts the bin/factory parseArgs shape ({ _, flags })", withRoots(() => {
  // bin/factory calls run(cfg, args) with its parseArgs output; the object
  // branch must read flags, not top-level keys.
  const check = materialize.run({}, { _: ["materialize"], flags: { check: true } });
  assert.equal(check.mode, "check");
  const apply = materialize.run({}, { _: ["materialize"], flags: { apply: true } });
  assert.equal(apply.ok, true);
  assert.equal(apply.written, 5);
  // And a third positional arg (C) from bin/factory is ignored harmlessly.
  assert.equal(materialize.run({}, { _: ["materialize"], flags: { check: true } }, {}).mode, "check");
}));
