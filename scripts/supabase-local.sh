#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="${TMPDIR:-/tmp}/wellweb-supabase-local-baseline"
SUPABASE_BIN="$ROOT_DIR/node_modules/.bin/supabase"

if [[ ! -x "$SUPABASE_BIN" ]]; then
  echo "Supabase CLI not found. Run npm install first." >&2
  exit 1
fi

ACTION="${1:-start}"
case "$ACTION" in
  start) set -- start --exclude studio,vector,edge-runtime,logflare,analytics,realtime ;;
  stop) set -- stop ;;
  status) set -- status ;;
  reset) set -- db reset ;;
  *)
    echo "Allowed local-only actions: start, stop, status, reset" >&2
    exit 2
    ;;
esac

# Use the version of migration 1 originally applied in production. The current
# tracked copy contains later additions duplicated by migration 2. This temp
# workdir keeps the historical files in the repository untouched and unlinked.
mkdir -p "$LOCAL_DIR"
rm -rf "$LOCAL_DIR/migrations"
cp -R "$ROOT_DIR/supabase/migrations" "$LOCAL_DIR/migrations"
cp "$ROOT_DIR/supabase/config.toml" "$LOCAL_DIR/config.toml"
git -C "$ROOT_DIR" show '45f87a9^:supabase/migrations/202611020001_initial_identity.sql' \
  > "$LOCAL_DIR/migrations/202611020001_initial_identity.sql"

exec "$SUPABASE_BIN" --workdir "$LOCAL_DIR" "$@"
