#!/usr/bin/env bash
# Prove that a Paperclip backup actually restores. Plan §4 step 1 gates
# everything else on this: a backup you have never restored is a hypothesis.
#
# SAFETY: this never touches the live database. It creates a throwaway database
# in the same cluster, loads the dump into it, counts rows, and drops it.
# The live `paperclip` database is only ever read from.
set -euo pipefail

INSTANCE="$HOME/.paperclip/instances/default"
BACKUP_DIR="$INSTANCE/data/backups"
ENV_FILE="$INSTANCE/.env"
PORT="$(node -e "console.log(require('$INSTANCE/config.json').database.embeddedPostgresPort)")"
SCRATCH="paperclip_restore_test_$$"

DUMP="${1:-$(ls -1t "$BACKUP_DIR"/*.sql.gz | head -1)}"
echo "dump:    $DUMP"
echo "cluster: 127.0.0.1:$PORT"

# Connection string. A managed deployment sets DATABASE_URL in the instance
# .env; embedded-postgres does not — @paperclipai/db builds it at runtime with
# fixed credentials (see dist/migration-runtime.js).
URL="$(grep -oE 'postgres(ql)?://[^"'"'"' ]+' "$ENV_FILE" 2>/dev/null | head -1 || true)"
if [ -z "$URL" ]; then
  URL="postgres://paperclip:paperclip@127.0.0.1:$PORT/paperclip"
  echo "conn:    embedded default (no DATABASE_URL in .env)"
fi
BASE="${URL%/*}"                     # strip the database name
PSQL=(psql "$BASE/postgres" -v ON_ERROR_STOP=1 -q -t -A)
command -v psql > /dev/null || PSQL=("/usr/lib/postgresql/18/bin/psql" "$BASE/postgres" -v ON_ERROR_STOP=1 -q -t -A)

echo
echo "--- live row counts (read-only) ---"
live_agents="$(psql "$URL" -t -A -c 'select count(*) from agents' 2>/dev/null || echo '?')"
live_co="$(psql "$URL" -t -A -c 'select count(*) from companies' 2>/dev/null || echo '?')"
echo "  agents=$live_agents companies=$live_co"

echo
echo "--- restoring into throwaway db: $SCRATCH ---"
"${PSQL[@]}" -c "CREATE DATABASE $SCRATCH" > /dev/null
trap '"${PSQL[@]}" -c "DROP DATABASE IF EXISTS $SCRATCH" > /dev/null 2>&1 || true' EXIT

if gunzip -c "$DUMP" | psql "$BASE/$SCRATCH" -v ON_ERROR_STOP=1 -q > /tmp/restore-test.log 2>&1; then
  echo "  load: OK"
else
  echo "  load: FAILED — see /tmp/restore-test.log" >&2
  tail -20 /tmp/restore-test.log >&2
  exit 1
fi

echo
echo "--- restored row counts ---"
r_agents="$(psql "$BASE/$SCRATCH" -t -A -c 'select count(*) from agents')"
r_co="$(psql "$BASE/$SCRATCH" -t -A -c 'select count(*) from companies')"
echo "  agents=$r_agents companies=$r_co"
psql "$BASE/$SCRATCH" -t -A -c "select name || ' [' || adapter_type || ']' from agents order by name" | sed 's/^/    /'

echo
if [ "$r_agents" = "$live_agents" ] && [ "$r_co" = "$live_co" ]; then
  echo "RESTORE PROVEN: counts match live ($r_agents agents, $r_co companies)."
else
  echo "MISMATCH: live agents=$live_agents companies=$live_co / restored agents=$r_agents companies=$r_co" >&2
  exit 1
fi
echo "throwaway database dropped."
