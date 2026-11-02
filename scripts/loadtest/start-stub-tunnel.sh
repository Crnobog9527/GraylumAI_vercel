#!/usr/bin/env bash
# Starts the model stub on this machine and a free Cloudflare quick tunnel in front of it (no account, no token), then prints the
# value for LOADTEST_MODEL_STUB_URL to THIS terminal only. Nothing is written to a file; Ctrl-C stops both.
set -euo pipefail

command -v cloudflared >/dev/null || { echo "cloudflared not installed (brew install cloudflared)" >&2; exit 1; }
cd "$(dirname "$0")/../.."

PORT="${LOAD_STUB_PORT:-8787}"
PREFIX="$(openssl rand -hex 16)"
LOG="$(mktemp)"

cleanup() { kill "${STUB_PID:-}" "${TUN_PID:-}" 2>/dev/null || true; rm -f "$LOG"; }
trap cleanup EXIT INT TERM

LOAD_STUB_HOST=127.0.0.1 LOAD_STUB_PORT="$PORT" LOAD_STUB_PREFIX="$PREFIX" node scripts/loadtest/openrouter-stub.mjs &
STUB_PID=$!
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$LOG" 2>&1 &
TUN_PID=$!

URL=""
for _ in $(seq 1 60); do
  URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "tunnel did not come up in 60 s" >&2; exit 1; }

echo
echo "LOADTEST_MODEL_STUB_URL = $URL/$PREFIX"
echo "Health check:  curl -s $URL/healthz"
echo "Call counter:  curl -s $URL/__stats"
echo "Keep this terminal open and the Mac awake until the run is over. Ctrl-C stops the stub and the tunnel."
wait
