import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// The read-only verifier is the boundary that makes a review verdict mean
// something: the command that DECIDES the verdict must not be able to change
// what it is judging, and must not be able to carry anything out. Every claim
// in ops/omp-verify-bwrap.sh's header is asserted here against the real bwrap,
// because a sandbox nobody probed is a sandbox nobody has.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.resolve(HERE, "../../ops/omp-verify-bwrap.sh");

const haveBwrap = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).status === 0;
const skip = haveBwrap ? false : "bwrap not installed";

function worktree(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

// Always invoke through `bash` rather than relying on the executable bit, so the
// test asserts the script's behaviour and not the checkout's file mode.
function verify(args, opts = {}) {
  return spawnSync("bash", [VERIFY, ...args], { encoding: "utf8", ...opts });
}

test("the verifier runs a declared command in the worktree and propagates its exit code", { skip }, () => {
  const wt = worktree({
    "test_ok.py": "def test_pass():\n    assert True\n",
    "test_bad.py": "def test_fail():\n    assert 1 == 2\n",
  });

  const pass = verify(["--worktree", wt, "--cwd", ".", "--", "python3", "-m", "pytest", "-q", "test_ok.py"]);
  assert.equal(pass.status, 0, `expected a passing acceptance command to exit 0:\n${pass.stdout}${pass.stderr}`);

  const fail = verify(["--worktree", wt, "--cwd", ".", "--", "python3", "-m", "pytest", "-q", "test_bad.py"]);
  assert.equal(fail.status, 1, "a failing acceptance command must surface a non-zero exit, not be swallowed");
});

// This is the property the whole review stage rests on. If it regresses, an
// acceptance command could edit the code it is judging into passing.
test("the verifier mounts the worktree READ-ONLY, so a command cannot edit what it judges", { skip }, () => {
  const wt = worktree({ "file.txt": "original\n" });

  const w = verify(["--worktree", wt, "--", "sh", "-c", "echo tampered > file.txt"]);
  assert.notEqual(w.status, 0, "a write into the worktree must fail");
  assert.match(w.stderr, /Read-only file system/);
  assert.equal(fs.readFileSync(path.join(wt, "file.txt"), "utf8"), "original\n",
    "the file on disk must be untouched");

  // Creating a new file is the same violation wearing a different hat.
  const c = verify(["--worktree", wt, "--", "sh", "-c", "touch newfile"]);
  assert.notEqual(c.status, 0);
  assert.equal(fs.existsSync(path.join(wt, "newfile")), false);
});

test("the verifier has no network, unlike the engineer sandbox whose network is deliberately shared", { skip }, () => {
  const wt = worktree();
  const r = verify(["--worktree", wt, "--", "sh", "-c", "getent hosts example.com"]);
  assert.notEqual(r.status, 0, "DNS resolution must fail inside a network-isolated verifier");
});

test("the verifier clears every credential rather than stripping a known list", { skip }, () => {
  const wt = worktree();
  const r = verify(["--worktree", wt, "--", "sh", "-c", "env"], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "sk-should-not-survive",
      OPENROUTER_API_KEY: "sk-should-not-survive",
      PAPERCLIP_API_KEY: "should-not-survive",
      SOME_VARIABLE_NOBODY_ANTICIPATED: "should-not-survive",
    },
  });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /should-not-survive/,
    "a strip list fails open on the variable nobody thought of; --clearenv must not");

  // The allowlist that IS handed back, so a future edit that drops one is caught.
  const names = r.stdout.split("\n").map((l) => l.split("=")[0]).filter(Boolean);
  for (const keep of ["PATH", "HOME", "TMPDIR", "FACTORY_VERIFIER"]) {
    assert.ok(names.includes(keep), `${keep} must be set inside the verifier`);
  }
});

// Regression: HOME once pointed into the private tmpfs, which read as stricter
// and silently broke Python user-site resolution — pytest lives under
// ~/.local, so every acceptance command returned "No module named pytest" and
// every criterion would have come back falsely BLOCKED.
test("the verifier keeps HOME real, so interpreter user-site resolution still works", { skip }, () => {
  const wt = worktree();
  const r = verify(["--worktree", wt, "--", "sh", "-c", "echo $HOME"]);
  assert.equal(r.stdout.trim(), process.env.HOME,
    "HOME must be the real home; the read-only root is what prevents writes to it");

  const p = verify(["--worktree", wt, "--", "python3", "-m", "pytest", "--version"]);
  assert.equal(p.status, 0, `pytest must resolve inside the verifier:\n${p.stdout}${p.stderr}`);
});

test("the verifier refuses a cwd that resolves outside the worktree, including through a symlink", { skip }, () => {
  const wt = worktree();

  const up = verify(["--worktree", wt, "--cwd", "../..", "--", "pwd"]);
  assert.equal(up.status, 78);
  assert.match(up.stderr, /outside worktree/);

  fs.symlinkSync("/etc", path.join(wt, "escape"));
  const link = verify(["--worktree", wt, "--cwd", "escape", "--", "pwd"]);
  assert.equal(link.status, 78, "a symlink planted inside the worktree must not widen the cwd");
  assert.match(link.stderr, /outside worktree/);
});

test("the verifier refuses to run without a worktree or without a command", { skip }, () => {
  const noWt = verify(["--", "true"]);
  assert.equal(noWt.status, 64);
  assert.match(noWt.stderr, /--worktree is required/);

  const wt = worktree();
  const noCmd = verify(["--worktree", wt]);
  assert.equal(noCmd.status, 64);
  assert.match(noCmd.stderr, /no command given/);

  const missing = verify(["--worktree", path.join(wt, "does-not-exist"), "--", "true"]);
  assert.equal(missing.status, 78);
  assert.match(missing.stderr, /does not exist/);
});

// A worktree under /tmp is masked by `--tmpfs /tmp` unless the bind is applied
// after it. Every fixture here lives under /tmp, so a reordering regression
// would surface as "Can't chdir" rather than as a silent weakening.
test("the worktree bind survives the /tmp tmpfs, whatever the worktree's location", { skip }, () => {
  const wt = worktree({ "marker.txt": "present\n" });
  assert.ok(wt.startsWith(os.tmpdir()), "fixture must live under the tmpfs path to be a real regression test");
  const r = verify(["--worktree", wt, "--", "cat", "marker.txt"]);
  assert.equal(r.status, 0, `worktree must be visible: ${r.stderr}`);
  assert.equal(r.stdout, "present\n");
});
