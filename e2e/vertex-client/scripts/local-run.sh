#!/usr/bin/env bash
# ossspike1: run e2e specs with NO real secrets against a local Worker (wrangler dev --local, miniflare D1/R2/DO).
# usage: scripts/local-run.sh [--port N] [--project NAME] <spec basenames...>     (no specs = all of tests/)
# Nothing live is touched: scratch persist dir + scratch .dev.vars (random E2E_TOKEN/SESSION_SECRET) under a mktemp dir.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd); WD=$(cd "$HERE/../../workers/vertex-client" && pwd)
PORT=${LOCAL_RUN_PORT:-38791}; INSPECT=${LOCAL_RUN_INSPECT:-39331}; PROJECTS=(); while [ $# -gt 0 ]; do case $1 in --port) PORT=$2; shift 2;; --project) PROJECTS+=(--project "$2"); shift 2;; *) break;; esac; done
SCR=${LOCAL_RUN_DIR:-$(mktemp -d /tmp/vclient-local.XXXXXX)}; mkdir -p "$SCR/state"
umask 077
printf 'E2E_TOKEN=%s\nSESSION_SECRET=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > "$SCR/dev.vars"
set -a; . "$SCR/dev.vars"; set +a
cd "$WD"
[ -d node_modules ] || npm ci --no-audit --no-fund
[ -d dist/client ] || npm run build
npx wrangler d1 migrations apply DB --local --persist-to "$SCR/state" >"$SCR/migrate.log" 2>&1 || { tail -20 "$SCR/migrate.log"; exit 1; }
# fail fast if the ports are taken (an orphan from an older run would answer /auth/config with ITS token -> every login 401)
for p in "$PORT" "$INSPECT"; do ! ss -ltn | grep -q ":$p " || { echo "port $p already in use" >&2; exit 1; }; done
setsid npx wrangler dev --local --port "$PORT" --inspector-port "$INSPECT" --persist-to "$SCR/state" --env-file "$SCR/dev.vars" >"$SCR/wrangler.log" 2>&1 &
WP=$!; trap 'kill -- -$WP 2>/dev/null; wait $WP 2>/dev/null || true' EXIT   # setsid: kill the whole group (npx -> wrangler -> workerd)
for i in $(seq 1 90); do curl -fsS -o /dev/null "http://localhost:$PORT/auth/config" 2>/dev/null && break; sleep 1; kill -0 $WP 2>/dev/null || { tail -30 "$SCR/wrangler.log"; exit 1; }; done
echo "worker up on :$PORT (scratch $SCR)"
cd "$HERE"; [ -d node_modules ] || npm ci --no-audit --no-fund
export E2E_BASE_URL="http://localhost:$PORT" E2E_RETRIES=${E2E_RETRIES:-0}
if [ "${LOCAL_RUN_EACH:-0}" = 1 ]; then   # one playwright process per spec file (10 min cap each), per-file json in $SCR/each/ - classification mode
  mkdir -p "$SCR/each"
  for f in "$@"; do
    E2E_OUT="$SCR/each/$f" timeout 600 npx playwright test "$f" --timeout "${LOCAL_RUN_TIMEOUT:-40000}" --reporter=line "${PROJECTS[@]}" >"$SCR/each/$f.log" 2>&1 || true
    echo "$f done $(date +%T)"
  done
else
  rc=0; E2E_OUT="$SCR/out" npx playwright test "$@" "${PROJECTS[@]}" || rc=$?
fi
echo "results: $SCR/out/results.json"
exit ${rc:-0}   # non-EACH mode: playwright's own exit status (CI must go red on a failing spec); EACH mode is classification-only (always 0)
