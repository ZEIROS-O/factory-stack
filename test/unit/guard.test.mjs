import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { evaluate, isInside, targetsOf, resolveWorkspace } from "../../omp/worktree-guard.js";

// A real repo + real linked worktree. The guard reads HEAD off disk and resolves
// symlinks for real, so a mocked filesystem would test the mock, not the guard.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "f.txt"), "base");
  git("add", "-A"); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "operator-work.txt"), "DIRTY");
  const wt = path.join(root, "wt");
  git("worktree", "add", "-q", wt, "-b", "paperclip/TEST");
  return { root, repo, wt, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const envFor = (f, over = {}) => ({
  PAPERCLIP_WORKSPACE_WORKTREE_PATH: f.wt,
  PAPERCLIP_WORKSPACE_BRANCH: "paperclip/TEST",
  ...over,
});
const call = (input, toolName = "write") => ({ toolName, input });

test("non-mutating tools are never blocked", () => {
  const f = fixture();
  try {
    for (const t of ["read", "grep", "glob", "bash", "todo"]) {
      assert.equal(evaluate(call({ path: "/etc/passwd" }, t), envFor(f), f.wt), null);
    }
  } finally { f.cleanup(); }
});

test("missing workspace environment blocks every mutation", () => {
  const f = fixture();
  try {
    const r = evaluate(call({ path: "x.txt" }), {}, f.wt);
    assert.ok(r?.block, "must block with no workspace env");
    assert.match(r.reason, /No PAPERCLIP_WORKSPACE_WORKTREE_PATH/);
  } finally { f.cleanup(); }
});

test("a forged workspace root that does not exist blocks", () => {
  const f = fixture();
  try {
    const r = evaluate(call({ path: "x.txt" }),
      { PAPERCLIP_WORKSPACE_WORKTREE_PATH: path.join(f.root, "nope") }, f.wt);
    assert.ok(r?.block);
    assert.match(r.reason, /does not exist on disk/);
  } finally { f.cleanup(); }
});

test("cwd in the primary tree blocks even when the env names a worktree", () => {
  const f = fixture();
  try {
    const r = evaluate(call({ path: "x.txt" }), envFor(f), f.repo);
    assert.ok(r?.block, "primary-tree cwd must block");
    assert.match(r.reason, /outside the assigned worktree/);
  } finally { f.cleanup(); }
});

test("branch mismatch blocks", () => {
  const f = fixture();
  try {
    const r = evaluate(call({ path: "x.txt" }),
      envFor(f, { PAPERCLIP_WORKSPACE_BRANCH: "main" }), f.wt);
    assert.ok(r?.block, "declared branch != HEAD must block");
    assert.match(r.reason, /Branch mismatch/);
  } finally { f.cleanup(); }
});

test("a write inside the worktree on the right branch is allowed", () => {
  const f = fixture();
  try {
    assert.equal(evaluate(call({ path: "new.txt" }), envFor(f), f.wt), null);
    assert.equal(evaluate(call({ file_path: path.join(f.wt, "a/b/c.txt") }), envFor(f), f.wt), null);
  } finally { f.cleanup(); }
});

test("a write outside the worktree blocks", () => {
  const f = fixture();
  try {
    const r = evaluate(call({ path: path.join(f.repo, "operator-work.txt") }), envFor(f), f.wt);
    assert.ok(r?.block);
    assert.match(r.reason, /outside the attempt worktree/);
  } finally { f.cleanup(); }
});

test("SYMLINK ESCAPE: a link inside the worktree pointing out is blocked", () => {
  const f = fixture();
  try {
    const link = path.join(f.wt, "escape.txt");
    fs.symlinkSync(path.join(f.repo, "operator-work.txt"), link);
    // The literal string is inside the worktree; only realpath resolution catches it.
    assert.ok(!path.relative(f.wt, link).startsWith(".."), "precondition: literal path looks inside");
    const r = evaluate(call({ path: link }), envFor(f), f.wt);
    assert.ok(r?.block, "symlink escape must block");
    assert.match(r.reason, /outside the attempt worktree/);
  } finally { f.cleanup(); }
});

test("SYMLINK ESCAPE via a linked DIRECTORY is blocked", () => {
  const f = fixture();
  try {
    fs.symlinkSync(f.repo, path.join(f.wt, "out"));
    const r = evaluate(call({ path: path.join(f.wt, "out", "brand-new.txt") }), envFor(f), f.wt);
    assert.ok(r?.block, "write through a linked directory must block");
  } finally { f.cleanup(); }
});

test("targetless mutation blocks", () => {
  const f = fixture();
  try {
    const r = evaluate(call({ path: "" }), envFor(f), f.wt);
    assert.ok(r?.block);
    assert.match(r.reason, /no write target/);
  } finally { f.cleanup(); }
});

test("unknown mutating-tool shape blocks rather than passing", () => {
  const f = fixture();
  try {
    for (const input of [{ contents: "data" }, {}, null, "string", 42]) {
      const r = evaluate(call(input), envFor(f), f.wt);
      assert.ok(r?.block, `shape ${JSON.stringify(input)} must block`);
    }
    assert.match(evaluate(call({ contents: "x" }), envFor(f), f.wt).reason, /does not recognise/);
  } finally { f.cleanup(); }
});

test("multi-edit shapes are checked per entry; one bad target blocks all", () => {
  const f = fixture();
  try {
    const ok = evaluate(call({ edits: [{ path: "a.txt" }, { file_path: "b.txt" }] }, "multiedit"), envFor(f), f.wt);
    assert.equal(ok, null);
    const bad = evaluate(
      call({ edits: [{ path: "a.txt" }, { path: path.join(f.repo, "operator-work.txt") }] }, "multiedit"),
      envFor(f), f.wt);
    assert.ok(bad?.block, "a single escaping edit must block the whole call");
  } finally { f.cleanup(); }
});

test("targetsOf distinguishes unrecognised (null) from targetless (empty)", () => {
  assert.equal(targetsOf({ contents: "x" }), null, "unrecognised shape -> null");
  assert.deepEqual(targetsOf({ path: "" }), [], "recognised but empty -> []");
  assert.deepEqual(targetsOf({ path: "a.txt" }), ["a.txt"]);
  assert.deepEqual(targetsOf({ path: "a.txt:12" }), ["a.txt"], "line suffix stripped");
});

test("resolveWorkspace prefers the worktree var and reports its provenance", () => {
  const w = resolveWorkspace({ PAPERCLIP_WORKSPACE_WORKTREE_PATH: "/a", PAPERCLIP_WORKSPACE_CWD: "/b" });
  assert.equal(w.root, "/a");
  assert.equal(w.fromWorktreeVar, true);
  const w2 = resolveWorkspace({ PAPERCLIP_WORKSPACE_CWD: "/b" });
  assert.equal(w2.root, "/b");
  assert.equal(w2.fromWorktreeVar, false);
});

test("isInside is false for a null root — no root means no authority", () => {
  assert.equal(isInside("/anything", null), false);
});
