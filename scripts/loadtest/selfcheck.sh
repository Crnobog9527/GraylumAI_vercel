#!/usr/bin/env bash
# One-account self-check before the 100-user run: proves the deployed app really sends its model calls to the stub (zero model spend).
# The stub's call counter is read BEFORE and AFTER one real app turn; the check passes only if ALL THREE hold: exactly one turn was
# completed, it did not fail (failedTurns and failedOther are 0 in the summary this run wrote: the driver's exit code alone is not
# enough, it is 0 even when the turn failed), and the counter went UP. (The tunnel's own streaming check also calls the stub, so "counter above 0" proves nothing.) Any other outcome exits 1:
# do NOT start the full run, the app may be calling the paid provider.
# Environment (from the private env file): LOADTEST_MODEL_STUB_URL (same value as in Vercel), LOADTEST_BASE_URL,
# LOADTEST_ALLOWED_APP_HOST, LOADTEST_ACCOUNTS_FILE. DRIVER_CMD overrides the driver (tests only).
set -uo pipefail
cd "$(dirname "$0")/../.."

for v in LOADTEST_MODEL_STUB_URL LOADTEST_ALLOWED_APP_HOST; do [ -n "${!v:-}" ] || { echo "STOP: $v is not set" >&2; exit 1; }; done
node -e 'new URL(process.argv[1])' "$LOADTEST_MODEL_STUB_URL" 2>/dev/null || { echo "STOP: LOADTEST_MODEL_STUB_URL is not a URL" >&2; exit 1; }
# The counter sits behind the stub's secret prefix. On the Vercel copy (deploy-stub-vercel.sh) it counts one instance only: a STOP there
# can be a different instance answering (run it again); a PASS is confirmed in the database (the turn's provider id starts gen-load-).
STATS="${LOADTEST_MODEL_STUB_URL%/}/__stats"
calls() { curl -s -m 10 "$STATS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const n=JSON.parse(s).calls;console.log(Number.isInteger(n)?n:"")}catch{console.log("")}})'; }

BEFORE="$(calls)"
[ -n "$BEFORE" ] || { echo "STOP: cannot read the stub's call counter (is the stub up?)" >&2; exit 1; }
echo "stub calls before: $BEFORE"

OUT="${SELFCHECK_OUT:-$HOME/graylum-loadtest/selfcheck-$(date +%s)}"
if [ -n "${DRIVER_CMD:-}" ]; then bash -c "$DRIVER_CMD"; else
  LOADTEST_ALLOWED_HOST="$LOADTEST_ALLOWED_APP_HOST" node scripts/loadtest/core-path-load.mjs --out "$OUT" --calibrate --turns 1 --go; fi
DRIVER_STATUS=$?
[ "$DRIVER_STATUS" = 0 ] || { echo "STOP: the one-account turn failed (exit $DRIVER_STATUS)" >&2; exit 1; }
if [ -z "${DRIVER_CMD:-}" ]; then
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if(s.turns!==1||s.failedTurns!==0||s.failedOther!==0){console.error(`STOP: expected exactly 1 completed turn with no failure, got turns=${s.turns} failedTurns=${s.failedTurns} failedOther=${s.failedOther} codes=${JSON.stringify(s.codes)}`);process.exit(1)}' \
    "$OUT/stage-0-1.summary.json" || { echo "STOP: the turn did not complete cleanly (or its summary is missing); do not run the full test." >&2; exit 1; }
fi

AFTER="$(calls)"
[ -n "$AFTER" ] || { echo "STOP: cannot read the stub's call counter after the turn" >&2; exit 1; }
echo "stub calls after: $AFTER"
if [ "$AFTER" -gt "$BEFORE" ]; then echo "PASS: the app called the stub ($((AFTER - BEFORE)) new calls)"; exit 0; fi
echo "STOP: the stub saw no new call. The app is NOT rerouted (variables missing, wrong, or not redeployed). Do not run the full test." >&2
exit 1
