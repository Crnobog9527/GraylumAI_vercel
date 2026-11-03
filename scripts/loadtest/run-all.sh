#!/usr/bin/env bash
# One command for the final 100-user run: calibration first (alone, no samplers), then both samplers in the BACKGROUND, then the
# driver, then wait for the samplers, then the summary and a check that the samples cover the driver's time window.
#   scripts/loadtest/run-all.sh            real run (needs the environment of docs/validation/core-path-v2/vercel-run-plan.md, step 2)
#   scripts/loadtest/run-all.sh --dry-run  a few seconds, no network and no database: stand-in processes, same orchestration
# OUT defaults to ~/graylum-loadtest/vercel-final (must stay outside the repository). SAMPLE_SECONDS is how long the samplers run.
set -uo pipefail
cd "$(dirname "$0")/../.."

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
OUT="${OUT:-$HOME/graylum-loadtest/vercel-final}"
[ "$DRY" = 1 ] && OUT="$(mktemp -d)/dry-run"
mkdir -p "$OUT"
EVERY=5 # sampler interval of the waits sampler; the connections sampler uses 1
SAMPLE_SECONDS="${SAMPLE_SECONDS:-4800}"
GRACE=30
if [ "$DRY" = 1 ]; then SAMPLE_SECONDS=14; EVERY=1; fi

# Stand-ins for the dry run: a sampler that writes {t} every second, and a driver that only waits.
stand_in_sampler() { node -e 'const f=process.argv[1],end=Date.now()+Number(process.argv[2])*1000,fs=require("fs");
  const tick=()=>{fs.appendFileSync(f,JSON.stringify({t:Date.now(),rows:[]})+"\n");Date.now()<end?setTimeout(tick,1000):0};tick()' "$1" "$2"; }

if [ "$DRY" = 0 ]; then
  echo "== 1/4 calibration (one user, no samplers, ~5 min)"
  node scripts/loadtest/core-path-load.mjs --out "$OUT/calibrate" --calibrate --go || { echo "calibration failed" >&2; exit 1; }
fi

echo "== 2/4 samplers in the background ($SAMPLE_SECONDS s)"
if [ "$DRY" = 1 ]; then
  stand_in_sampler "$OUT/connections.jsonl" "$SAMPLE_SECONDS" >"$OUT/connections.log" 2>&1 & CONN_PID=$!
  stand_in_sampler "$OUT/waits.jsonl" "$SAMPLE_SECONDS" >"$OUT/waits.log" 2>&1 & WAIT_PID=$!
else
  node scripts/loadtest/sample-connections.mjs --out "$OUT/connections.jsonl" --seconds "$SAMPLE_SECONDS" >"$OUT/connections.log" 2>&1 & CONN_PID=$!
  node scripts/loadtest/sample-waits.mjs --out "$OUT/waits.jsonl" --seconds "$SAMPLE_SECONDS" --every "$EVERY" >"$OUT/waits.log" 2>&1 & WAIT_PID=$!
fi
echo "   connections sampler pid $CONN_PID, log $OUT/connections.log"
echo "   waits sampler       pid $WAIT_PID, log $OUT/waits.log"
sleep 3
for pid in $CONN_PID $WAIT_PID; do kill -0 "$pid" 2>/dev/null || { echo "a sampler died at start; see the logs" >&2; kill $CONN_PID $WAIT_PID 2>/dev/null; exit 1; }; done

echo "== 3/4 driver"
START_MS=$(node -e 'console.log(Date.now())')
if [ "$DRY" = 1 ]; then sleep 8; else node scripts/loadtest/core-path-load.mjs --out "$OUT/series" --series --go; fi
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
echo "driver exit $DRIVER_STATUS, coverage exit $COVER, output $OUT"
[ "$DRIVER_STATUS" = 0 ] && [ "$COVER" = 0 ]
