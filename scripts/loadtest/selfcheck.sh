#!/usr/bin/env bash
# One-account self-check before the 100-user run: proves the deployed app really sends its model calls to the stub (zero model spend).
# The stub's call counter is read BEFORE and AFTER one real app turn; the check passes only if the counter went UP and the turn
# succeeded. (The tunnel's own streaming check also calls the stub, so "counter above 0" proves nothing.) Any other outcome exits 1:
# do NOT start the full run, the app may be calling the paid provider.
# Environment (from the private env file): LOADTEST_MODEL_STUB_URL (same value as in Vercel), LOADTEST_BASE_URL,
# LOADTEST_ALLOWED_APP_HOST, LOADTEST_ACCOUNTS_FILE. DRIVER_CMD overrides the driver (tests only).
set -uo pipefail
cd "$(dirname "$0")/../.."

for v in LOADTEST_MODEL_STUB_URL LOADTEST_ALLOWED_APP_HOST; do [ -n "${!v:-}" ] || { echo "STOP: $v is not set" >&2; exit 1; }; done
ORIGIN="$(node -e 'console.log(new URL(process.argv[1]).origin)' "$LOADTEST_MODEL_STUB_URL" 2>/dev/null)" || { echo "STOP: LOADTEST_MODEL_STUB_URL is not a URL" >&2; exit 1; }
calls() { curl -s -m 10 "$ORIGIN/__stats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const n=JSON.parse(s).calls;console.log(Number.isInteger(n)?n:"")}catch{console.log("")}})'; }

BEFORE="$(calls)"
[ -n "$BEFORE" ] || { echo "STOP: cannot read the stub's call counter at $ORIGIN/__stats (is the stub and tunnel up?)" >&2; exit 1; }
echo "stub calls before: $BEFORE"

OUT="${SELFCHECK_OUT:-$HOME/graylum-loadtest/selfcheck-$(date +%s)}"
if [ -n "${DRIVER_CMD:-}" ]; then bash -c "$DRIVER_CMD"; else
  LOADTEST_ALLOWED_HOST="$LOADTEST_ALLOWED_APP_HOST" node scripts/loadtest/core-path-load.mjs --out "$OUT" --calibrate --turns 1 --go; fi
DRIVER_STATUS=$?
[ "$DRIVER_STATUS" = 0 ] || { echo "STOP: the one-account turn failed (exit $DRIVER_STATUS)" >&2; exit 1; }

AFTER="$(calls)"
[ -n "$AFTER" ] || { echo "STOP: cannot read the stub's call counter after the turn" >&2; exit 1; }
echo "stub calls after: $AFTER"
if [ "$AFTER" -gt "$BEFORE" ]; then echo "PASS: the app called the stub ($((AFTER - BEFORE)) new calls)"; exit 0; fi
echo "STOP: the stub saw no new call. The app is NOT rerouted (variables missing, wrong, or not redeployed). Do not run the full test." >&2
exit 1
