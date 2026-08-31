import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "../..");

function writeExecutable(file, body) {
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  fs.chmodSync(file, 0o755);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-lifecycle-"));
  const instance = path.join(root, "instance");
  const bin = path.join(root, "bin");
  const db = path.join(root, "db");
  const state = path.join(root, "state");
  fs.mkdirSync(instance); fs.mkdirSync(bin); fs.mkdirSync(db); fs.mkdirSync(state);
  const port = 43100;
  fs.writeFileSync(path.join(instance, "config.json"), JSON.stringify({
    database: { embeddedPostgresDataDir: db, embeddedPostgresPort: 43101 },
    server: { host: "127.0.0.1", port },
  }));
  writeExecutable(path.join(bin, "tmux"), `
cmd="$1"; shift
case "$cmd" in
  has-session) test -f "$PAPERCLIP_TEST_STATE/session" ;;
  list-panes)
    test -f "$PAPERCLIP_TEST_STATE/session"
    printf '%s\\n' "\${PAPERCLIP_TEST_PANE_PID:-$PAPERCLIP_TEST_PID}"
    ;;
  new-session)
    printf '%s\\n' "$cmd $*" >> "$PAPERCLIP_TEST_STATE/tmux-calls"
    : > "$PAPERCLIP_TEST_STATE/session"
    if test -f "$PAPERCLIP_TEST_STATE/post-health-invalid"; then
      printf '{}' > "$PAPERCLIP_INSTANCE/runtime-info.json"
    else
      printf '{"schemaVersion":1,"instanceId":"default","pid":%s,"host":"127.0.0.1","port":43100,"dashboardUrl":"http://127.0.0.1:43100","startedAt":"2026-08-31T00:00:00.000Z"}\\n' "$PAPERCLIP_TEST_PID" > "$PAPERCLIP_INSTANCE/runtime-info.json"
    fi
    ;;
  send-keys|kill-session)
    printf '%s\\n' "$cmd $*" >> "$PAPERCLIP_TEST_STATE/tmux-calls"
    rm -f "$PAPERCLIP_TEST_STATE/session" "$PAPERCLIP_INSTANCE/runtime-info.json"
    ;;
  *) echo "unexpected tmux command: $cmd" >&2; exit 92 ;;
esac
`);
  const paperclipBin = path.join(bin, "paperclipai");
  writeExecutable(paperclipBin, "exit 91");
  writeExecutable(path.join(bin, "ss"), `
if test -f "$PAPERCLIP_TEST_STATE/ss-failure"; then
  echo 'ss unavailable' >&2
  exit 73
fi
if test -f "$PAPERCLIP_TEST_STATE/occupied" || test -f "$PAPERCLIP_TEST_STATE/session"; then
  echo 'LISTEN 0 511 127.0.0.1:43100 0.0.0.0:*'
fi
`);
  writeExecutable(path.join(bin, "curl"), `
if test -f "$PAPERCLIP_TEST_STATE/session" && ! test -f "$PAPERCLIP_TEST_STATE/unhealthy"; then
  printf '{"status":"ok"}'
  exit 0
fi
exit 7
`);
  writeExecutable(path.join(bin, "ps"), `
if [[ " $* " == *" user="* ]]; then
  printf '%s\\n' "$(id -un)"
elif [[ " $* " == *" ppid="* ]]; then
  printf '1\\n'
elif [[ " $* " == *" -eo "* ]]; then
  if test -f "$PAPERCLIP_TEST_STATE/session" || test -f "$PAPERCLIP_TEST_STATE/preexisting-duplicate"; then
    if test -f "$PAPERCLIP_TEST_STATE/tmux-launcher"; then
      printf '%s tmux new-session -d -s paperclip-default exec %s run --instance default\\n' "$$" "$PAPERCLIP_BIN"
    fi
    printf '%s node %s run --instance default\\n' "$PAPERCLIP_TEST_PID" "$PAPERCLIP_BIN"
    if test -f "$PAPERCLIP_TEST_STATE/duplicate"; then
      printf '%s node %s run --instance default\\n' "$$" "$PAPERCLIP_BIN"
    fi
    if test -f "$PAPERCLIP_TEST_STATE/preexisting-duplicate"; then
      printf '%s node %s run --instance default\\n' "$$" "$PAPERCLIP_BIN"
    fi
  fi
else
  printf 'node %s run --instance default\\n' "$PAPERCLIP_BIN"
fi
`);
  writeExecutable(path.join(bin, "stat"), `
if test -f "$PAPERCLIP_TEST_STATE/bad-owner"; then
  printf '%s\\n' "$(( $(id -u) + 1 ))"
else
  exec /usr/bin/stat "$@"
fi
`);
  return {
    root, instance, bin, state, paperclipBin, panePid: String(process.pid),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function run(f, name) {
  return spawnSync(path.join(repo, "ops", `paperclip-${name}.sh`), [], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      PAPERCLIP_INSTANCE: f.instance,
      PAPERCLIP_BIN: f.paperclipBin,
      PAPERCLIP_NODE_BIN: process.execPath,
      PAPERCLIP_SESSION: "paperclip-default",
      PAPERCLIP_TEST_STATE: f.state,
      PAPERCLIP_TEST_PID: String(process.pid),
      PAPERCLIP_TEST_PANE_PID: f.panePid,
    },
  });
}

function stderr(result) {
  return result.stderr ?? result.error?.message ?? "";
}

function writeRuntimeInfo(f) {
  fs.writeFileSync(path.join(f.instance, "runtime-info.json"), JSON.stringify({
    schemaVersion: 1, instanceId: "default", pid: process.pid, host: "127.0.0.1", port: 43100,
    dashboardUrl: "http://127.0.0.1:43100", startedAt: "2026-08-31T00:00:00.000Z",
  }));
}

test("start refuses stale Paperclip PID metadata without creating a tmux session", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.instance, "runtime-info.json"), JSON.stringify({
      schemaVersion: 1, instanceId: "default", pid: 999999, host: "127.0.0.1", port: 43100,
      dashboardUrl: "http://127.0.0.1:43100", startedAt: "2026-08-31T00:00:00.000Z",
    }));
    const result = run(f, "start");
    assert.notEqual(result.status, 0, `${stderr(result)}\n${result.stdout}`);
    assert.match(stderr(result), /stale PID metadata/i);
    assert.equal(fs.existsSync(path.join(f.state, "session")), false);
  } finally { f.cleanup(); }
});

test("start refuses an occupied API port before creating a tmux session", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, "occupied"), "yes");
    const result = run(f, "start");
    assert.notEqual(result.status, 0);
    assert.match(stderr(result), /port 43100 is already occupied/i);
    assert.equal(fs.existsSync(path.join(f.state, "session")), false);
  } finally { f.cleanup(); }
});

test("start refuses a duplicate tracked tmux session", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, "session"), "yes");
    const result = run(f, "start");
    assert.notEqual(result.status, 0);
    assert.match(stderr(result), /tmux session .* already exists/i);
  } finally { f.cleanup(); }
});

test("start refuses pre-existing Paperclip processes before creating a tmux session", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, "preexisting-duplicate"), "yes");
    const result = run(f, "start");
    assert.notEqual(result.status, 0);
    assert.match(stderr(result), /expected no Paperclip processes before start/i);
    assert.equal(fs.existsSync(path.join(f.state, "session")), false);
    assert.equal(fs.existsSync(path.join(f.state, "tmux-calls")), false);
  } finally { f.cleanup(); }
});

test("status refuses a runtime PID that is not the named tmux pane", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, "session"), "yes");
    f.panePid = "999999";
    writeRuntimeInfo(f);
    const result = run(f, "status");
    assert.notEqual(result.status, 0);
    assert.match(stderr(result), /does not own runtime PID/i);
  } finally { f.cleanup(); }
});

test("start cleans up its new tmux session when post-health validation fails", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, "post-health-invalid"), "yes");
    const result = run(f, "start");
    assert.notEqual(result.status, 0, `${stderr(result)}\n${result.stdout}`);
    assert.match(stderr(result), /runtime PID metadata is malformed/i);
    assert.equal(fs.existsSync(path.join(f.state, "session")), false);
    assert.match(fs.readFileSync(path.join(f.state, "tmux-calls"), "utf8"), /kill-session/);
  } finally { f.cleanup(); }
});

test("stop refuses duplicate Paperclip processes before signaling the tmux session", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, "session"), "yes");
    fs.writeFileSync(path.join(f.state, "duplicate"), "yes");
    writeRuntimeInfo(f);
    const result = run(f, "stop");
    assert.notEqual(result.status, 0);
    assert.match(stderr(result), /expected exactly one Paperclip process/i);
    assert.equal(fs.existsSync(path.join(f.state, "session")), true);
    assert.equal(fs.existsSync(path.join(f.state, "tmux-calls")), false);
  } finally { f.cleanup(); }
});

test("start and stop fail closed when ss cannot inspect the API port", () => {
  const startFixture = fixture();
  try {
    fs.writeFileSync(path.join(startFixture.state, "ss-failure"), "yes");
    const result = run(startFixture, "start");
    assert.notEqual(result.status, 0);
    assert.match(stderr(result), /cannot inspect API port/i);
    assert.equal(fs.existsSync(path.join(startFixture.state, "session")), false);
  } finally { startFixture.cleanup(); }

  const stopFixture = fixture();
  try {
    fs.writeFileSync(path.join(stopFixture.state, "session"), "yes");
    fs.writeFileSync(path.join(stopFixture.state, "ss-failure"), "yes");
    writeRuntimeInfo(stopFixture);
    const result = run(stopFixture, "stop");
    assert.notEqual(result.status, 0);
    assert.match(stderr(result), /cannot inspect API port/i);
    assert.equal(fs.existsSync(path.join(stopFixture.state, "session")), true);
    assert.equal(fs.existsSync(path.join(stopFixture.state, "tmux-calls")), false);
  } finally { stopFixture.cleanup(); }
});

test("status does not mistake tmux's launch command for a second Paperclip server", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, "session"), "yes");
    fs.writeFileSync(path.join(f.state, "tmux-launcher"), "yes");
    writeRuntimeInfo(f);
    const result = run(f, "status");
    assert.equal(result.status, 0, stderr(result));
    assert.match(result.stdout, /Paperclip healthy/i);
  } finally { f.cleanup(); }
});

test("start refuses a database directory owned by another account", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, "bad-owner"), "yes");
    const result = run(f, "start");
    assert.notEqual(result.status, 0);
    assert.match(stderr(result), /database directory is not owned by the current user/i);
    assert.equal(fs.existsSync(path.join(f.state, "session")), false);
  } finally { f.cleanup(); }
});

test("status fails closed when the tracked Paperclip API is unhealthy", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, "session"), "yes");
    fs.writeFileSync(path.join(f.state, "unhealthy"), "yes");
    writeRuntimeInfo(f);
    const result = run(f, "status");
    assert.notEqual(result.status, 0);
    assert.match(stderr(result), /API is unhealthy/i);
  } finally { f.cleanup(); }
});

test("tracked wrappers start, report, and stop the one named Paperclip tmux session", () => {
  const f = fixture();
  try {
    const started = run(f, "start");
    assert.equal(started.status, 0, stderr(started));
    assert.match(started.stdout, /started in tmux session paperclip-default/i);
    const tmuxCalls = fs.readFileSync(path.join(f.state, "tmux-calls"), "utf8");
    assert.match(tmuxCalls, /new-session -d -s paperclip-default/);

    const status = run(f, "status");
    assert.equal(status.status, 0, stderr(status));
    assert.match(status.stdout, /Paperclip healthy/i);

    const stopped = run(f, "stop");
    assert.equal(stopped.status, 0, stderr(stopped));
    assert.match(stopped.stdout, /Paperclip stopped/i);
    assert.equal(fs.existsSync(path.join(f.state, "session")), false);
  } finally { f.cleanup(); }
});
