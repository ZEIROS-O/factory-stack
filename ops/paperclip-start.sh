#!/usr/bin/env bash
set -euo pipefail
exec "$(dirname -- "$0")/paperclip-lifecycle.sh" start
