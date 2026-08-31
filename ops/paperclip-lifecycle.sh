#!/usr/bin/env bash
# Tracked local Paperclip lifecycle. The named tmux session is the sole process
# owner: never start a second copy or bypass it with a foreground `run`.
set -euo pipefail

command_name="${1:-}"
case "$command_name" in start|status|stop) ;; *) echo "usage: $0 {start|status|stop}" >&2; exit 2 ;; esac

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
instance="${PAPERCLIP_INSTANCE:-$HOME/.paperclip/instances/default}"
instance_id="${PAPERCLIP_INSTANCE_ID:-default}"
config="$instance/config.json"
runtime_info="$instance/runtime-info.json"
session="${PAPERCLIP_SESSION:-paperclip-default}"
paperclip_bin="${PAPERCLIP_BIN:-$repo_root/node_modules/.bin/paperclipai}"
node_bin="${PAPERCLIP_NODE_BIN:-node}"
startup_timeout="${PAPERCLIP_STARTUP_TIMEOUT_SEC:-30}"

fail() { echo "paperclip lifecycle: $*" >&2; exit 1; }

read_config() {
  [[ -r "$config" ]] || fail "missing readable config: $config"
  local values
  if ! values="$("$node_bin" -e '
const c = require(process.argv[1]);
const port = c?.server?.port;
const db = c?.database?.embeddedPostgresDataDir;
if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof db !== "string" || !db) process.exit(2);
process.stdout.write(`${port}\n${db}\n`);
' "$config")"; then
    fail "config lacks a valid server port or embedded Postgres data directory"
  fi
  mapfile -t config_values <<< "$values"
  api_port="${config_values[0]:-}"
  db_dir="${config_values[1]:-}"
  [[ "$api_port" =~ ^[0-9]+$ && -n "$db_dir" ]] || fail "config values are malformed"
  api_url="http://127.0.0.1:$api_port/api/health"
}

check_db_ownership() {
  [[ -d "$db_dir" ]] || fail "embedded Postgres database directory is missing: $db_dir"
  local owner current
  owner="$(stat -c %u "$db_dir")" || fail "cannot inspect database directory ownership"
  current="$(id -u)"
  [[ "$owner" = "$current" ]] || fail "database directory is not owned by the current user"
}

port_is_occupied() {
  ss -ltnH "sport = :$api_port" 2>/dev/null | awk 'NF { found = 1 } END { exit !found }'
}

health_is_ok() {
  local response
  response="$(curl -fsS --max-time 3 "$api_url")" || return 1
  "$node_bin" -e 'try { process.exit(JSON.parse(process.argv[1])?.status === "ok" ? 0 : 1); } catch { process.exit(1); }' "$response"
}

runtime_pid=""
read_runtime_info() {
  [[ -f "$runtime_info" ]] || return 1
  local values
  if ! values="$("$node_bin" -e '
const r = require(process.argv[1]);
if (r?.schemaVersion !== 1 || r?.instanceId !== process.argv[2] || !Number.isInteger(r?.pid) || r.pid < 1) process.exit(2);
process.stdout.write(`${r.pid}\n${r.port}\n`);
' "$runtime_info" "$instance_id")"; then
    fail "runtime PID metadata is malformed"
  fi
  mapfile -t runtime_values <<< "$values"
  runtime_pid="${runtime_values[0]:-}"
  local runtime_port="${runtime_values[1]:-}"
  [[ "$runtime_pid" =~ ^[0-9]+$ && "$runtime_port" = "$api_port" ]] || fail "runtime PID metadata does not match this instance"
  return 0
}

pid_is_expected_paperclip() {
  local args
  kill -0 "$1" 2>/dev/null || return 1
  args="$(ps -p "$1" -o args= 2>/dev/null)" || return 1
  [[ "$args" == *"$paperclip_bin"* && "$args" == *" run"* ]]
}

check_runtime_metadata_for_start() {
  if ! read_runtime_info; then return 0; fi
  if ! kill -0 "$runtime_pid" 2>/dev/null; then
    fail "stale PID metadata for pid $runtime_pid; inspect $runtime_info before starting"
  fi
  pid_is_expected_paperclip "$runtime_pid" || fail "runtime PID metadata points to an unexpected process"
  fail "Paperclip PID metadata already names a running process; refusing an untracked duplicate"
}

check_exactly_one_process() {
  local count
  count="$(ps -eo pid=,args= 2>/dev/null | awk -v bin="$paperclip_bin" '$0 ~ bin && $0 ~ / run( |$)/ && $0 !~ /[[:space:]]tmux new-session / { count++ } END { print count + 0 }')"
  [[ "$count" = 1 ]] || fail "expected exactly one Paperclip process in tracked session; found $count"
}

check_running() {
  read_config
  check_db_ownership
  tmux has-session -t "$session" 2>/dev/null || fail "tracked tmux session $session is not running"
  read_runtime_info || fail "missing runtime PID metadata for tracked session"
  pid_is_expected_paperclip "$runtime_pid" || fail "runtime PID metadata is stale or points to an unexpected process"
  check_exactly_one_process
  port_is_occupied || fail "Paperclip API port $api_port is not listening"
  health_is_ok || fail "Paperclip API is unhealthy at $api_url"
}

start() {
  read_config
  check_db_ownership
  tmux has-session -t "$session" 2>/dev/null && fail "tmux session $session already exists; refusing duplicate start"
  check_runtime_metadata_for_start
  if port_is_occupied; then fail "port $api_port is already occupied; refusing to start Paperclip"; fi
  [[ -x "$paperclip_bin" ]] || fail "pinned Paperclip executable is missing or not executable: $paperclip_bin"
  tmux new-session -d -s "$session" "exec '$paperclip_bin' run --instance '$instance_id' --config '$config'"
  local deadline=$((SECONDS + startup_timeout))
  while (( SECONDS < deadline )); do
    if health_is_ok; then
      if check_running; then
        echo "Paperclip started in tmux session $session."
        return 0
      fi
      return 1
    fi
    sleep 1
  done
  tmux kill-session -t "$session" 2>/dev/null || true
  fail "Paperclip did not become healthy within ${startup_timeout}s; session $session was stopped"
}

status() {
  check_running
  echo "Paperclip healthy in tmux session $session on port $api_port."
}

stop() {
  read_config
  check_db_ownership
  tmux has-session -t "$session" 2>/dev/null || fail "tracked tmux session $session is not running"
  read_runtime_info || fail "missing runtime PID metadata for tracked session"
  pid_is_expected_paperclip "$runtime_pid" || fail "runtime PID metadata is stale or points to an unexpected process"
  tmux send-keys -t "$session" C-c
  local deadline=$((SECONDS + startup_timeout))
  while tmux has-session -t "$session" 2>/dev/null; do
    (( SECONDS < deadline )) || fail "Paperclip did not stop within ${startup_timeout}s; refusing to kill an unverified session"
    sleep 1
  done
  if [[ -f "$runtime_info" ]]; then
    read_runtime_info || fail "runtime PID metadata is malformed after stop"
    kill -0 "$runtime_pid" 2>/dev/null && fail "Paperclip PID $runtime_pid remains alive after tracked session stopped"
    rm -f -- "$runtime_info"
  fi
  port_is_occupied && fail "Paperclip API port $api_port remains occupied after stop"
  health_is_ok && fail "Paperclip API still reports healthy after stop"
  echo "Paperclip stopped (tmux session $session)."
}

"$command_name"
