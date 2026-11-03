#!/usr/bin/env bash
# One command for the final 100-user run: calibration first (alone, no samplers), then both samplers in the BACKGROUND, then the
# driver, then wait for the samplers, then the summary and a check that the samples cover the driver's time window.
#   scripts/loadtest/run-all.sh            real run (needs the environment of docs/validation/core-path-v2/vercel-run-plan.md, step 2)
#   scripts/loadtest/run-all.sh --dry-run  a few seconds, no network and no database: stand-in processes, same orchestration
# Hosts: LOADTEST_ALLOWED_APP_HOST (the Vercel app, for the driver) and LOADTEST_ALLOWED_DB_HOST (the database, for both samplers) are
# separate; each process gets only its own as LOADTEST_ALLOWED_HOST. Every run writes into its own new directory
# (RUN_ROOT/run-<timestamp>, RUN_ROOT defaults to ~/graylum-loadtest/vercel-final, outside the repository); a RUN_DIR that already
# holds anything is refused, so a summary or the coverage check never reads an earlier run. SAMPLE_SECONDS is how long the samplers run.
set -uo pipefail
cd "$(dirname "$0")/../.."

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
APP_HOST="${LOADTEST_ALLOWED_APP_HOST:-}"; DB_HOST="${LOADTEST_ALLOWED_DB_HOST:-}"
if [ "$DRY" = 1 ]; then APP_HOST="${APP_HOST:-app.dry-run.test}"; DB_HOST="${DB_HOST:-db.dry-run.test}"; RUN_ROOT="${RUN_ROOT:-$(mktemp -d)}"; fi
[ -n "$APP_HOST" ] && [ -n "$DB_HOST" ] || { echo "set LOADTEST_ALLOWED_APP_HOST and LOADTEST_ALLOWED_DB_HOST" >&2; exit 1; }
RUN_ROOT="${RUN_ROOT:-$HOME/graylum-loadtest/vercel-final}"
OUT="${RUN_DIR:-$RUN_ROOT/run-$(date +%Y%m%d-%H%M%S)-$$}"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then echo "refusing: $OUT already holds files from an earlier run" >&2; exit 1; fi
mkdir -p "$OUT"
EVERY=5 # sampler interval of the waits sampler; the connections sampler uses 1
SAMPLE_SECONDS="${SAMPLE_SECONDS:-4800}"
GRACE=30
DRY_DRIVER_SECONDS="${DRY_DRIVER_SECONDS:-8}"
if [ "$DRY" = 1 ]; then SAMPLE_SECONDS=$((DRY_DRIVER_SECONDS + 6)); EVERY=1; fi

# Stand-ins for the dry run: a sampler that writes {t} every second, and a driver that only waits. Each records the
# LOADTEST_ALLOWED_HOST it was started with, so the run can show every process received the host meant for it.
stand_in_sampler() { node -e 'const f=process.argv[1],end=Date.now()+Number(process.argv[2])*1000,fs=require("fs");
  fs.appendFileSync(process.argv[3],process.argv[4]+" "+process.env.LOADTEST_ALLOWED_HOST+"\n");
  const tick=()=>{fs.appendFileSync(f,JSON.stringify({t:Date.now(),rows:[]})+"\n");Date.now()<end?setTimeout(tick,1000):0};tick()' "$1" "$2" "$OUT/hosts.log" "$3"; }

if [ "$DRY" = 0 ]; then
  echo "== 1/4 calibration (one user, no samplers, ~5 min)"
  LOADTEST_ALLOWED_HOST="$APP_HOST" node scripts/loadtest/core-path-load.mjs --out "$OUT/calibrate" --calibrate --go || { echo "calibration failed" >&2; exit 1; }
fi

echo "== 2/4 samplers in the background ($SAMPLE_SECONDS s)"
if [ "$DRY" = 1 ]; then
  LOADTEST_ALLOWED_HOST="$DB_HOST" stand_in_sampler "$OUT/connections.jsonl" "$SAMPLE_SECONDS" connections >"$OUT/connections.log" 2>&1 & CONN_PID=$!
  LOADTEST_ALLOWED_HOST="$DB_HOST" stand_in_sampler "$OUT/waits.jsonl" "$SAMPLE_SECONDS" waits >"$OUT/waits.log" 2>&1 & WAIT_PID=$!
else
  LOADTEST_ALLOWED_HOST="$DB_HOST" node scripts/loadtest/sample-connections.mjs --out "$OUT/connections.jsonl" --seconds "$SAMPLE_SECONDS" >"$OUT/connections.log" 2>&1 & CONN_PID=$!
  LOADTEST_ALLOWED_HOST="$DB_HOST" node scripts/loadtest/sample-waits.mjs --out "$OUT/waits.jsonl" --seconds "$SAMPLE_SECONDS" --every "$EVERY" >"$OUT/waits.log" 2>&1 & WAIT_PID=$!
fi
echo "   connections sampler pid $CONN_PID, log $OUT/connections.log"
echo "   waits sampler       pid $WAIT_PID, log $OUT/waits.log"
sleep 3
for pid in $CONN_PID $WAIT_PID; do kill -0 "$pid" 2>/dev/null || { echo "a sampler died at start; see the logs" >&2; kill $CONN_PID $WAIT_PID 2>/dev/null; exit 1; }; done

echo "== 3/4 driver"
START_MS=$(node -e 'console.log(Date.now())')
if [ "$DRY" = 1 ]; then echo "driver $APP_HOST" >>"$OUT/hosts.log"; sleep "$DRY_DRIVER_SECONDS"; else LOADTEST_ALLOWED_HOST="$APP_HOST" node scripts/loadtest/core-path-load.mjs --out "$OUT/series" --series --go; fi
DRIVER_STATUS=$?
END_MS=$(node -e 'console.log(Date.now())')
echo "{\"startMs\":$START_MS,\"endMs\":$END_MS}" >"$OUT/window.json"

echo "== 4/4 wait for the samplers (grace $GRACE s after the driver, then stop the rest)"
for _ in $(seq 1 "$GRACE"); do kill -0 $CONN_PID 2>/dev/null || kill -0 $WAIT_PID 2>/dev/null || break; sleep 1; done
for pid in $CONN_PID $WAIT_PID; do kill -0 "$pid" 2>/dev/null && { echo "   stopping sampler $pid"; kill "$pid"; }; done
wait $CONN_PID $WAIT_PID 2>/dev/null

[ "$DRY" = 0 ] && node scripts/loadtest/sample-connections.mjs --summarize "$OUT/connections.jsonl"
node scripts/loadtest/lib/coverage.mjs "$OUT/window.json" $((EVERY + 2)) "$OUT/connections.jsonl" "$OUT/waits.jsonl"
COVER=$?
HOSTS=0
if [ "$DRY" = 1 ]; then
  cat "$OUT/hosts.log"
  grep -qx "driver $APP_HOST" "$OUT/hosts.log" && grep -qx "connections $DB_HOST" "$OUT/hosts.log" && grep -qx "waits $DB_HOST" "$OUT/hosts.log" || { echo "a process got the wrong host" >&2; HOSTS=1; }
fi
echo "driver exit $DRIVER_STATUS, coverage exit $COVER, hosts exit $HOSTS, output $OUT"
[ "$DRIVER_STATUS" = 0 ] && [ "$COVER" = 0 ] && [ "$HOSTS" = 0 ]
