#!/usr/bin/env bash
# Starts the model stub on this machine and a free tunnel in front of it, then prints, to THIS terminal only, the value for
# LOADTEST_MODEL_STUB_URL (tunnel address + the secret path segment) and a ready-to-paste streaming self-check. Nothing is written to a
# file; Ctrl-C stops everything. The Mac is kept awake while this runs.
#   scripts/loadtest/start-stub-tunnel.sh            Cloudflare quick tunnel (no account, no token)
#   scripts/loadtest/start-stub-tunnel.sh --ngrok    ngrok (needs its authtoken saved once with `ngrok config add-authtoken`)
set -euo pipefail

PROVIDER=cloudflared; [ "${1:-}" = "--ngrok" ] && PROVIDER=ngrok
command -v "$PROVIDER" >/dev/null || { echo "$PROVIDER is not installed (brew install $PROVIDER)" >&2; exit 1; }
command -v openssl >/dev/null && command -v node >/dev/null || { echo "openssl and node are required" >&2; exit 1; }
cd "$(dirname "$0")/../.."

PORT="${LOAD_STUB_PORT:-8787}"
export LOAD_STUB_PREFIX="$(openssl rand -hex 16)"
LOG="$(mktemp)"

cleanup() { kill "${STUB_PID:-}" "${TUN_PID:-}" "${AWAKE_PID:-}" 2>/dev/null || true; rm -f "$LOG"; }
trap cleanup EXIT INT TERM

caffeinate -dis -w $$ & AWAKE_PID=$!
LOAD_STUB_HOST=127.0.0.1 LOAD_STUB_PORT="$PORT" node scripts/loadtest/openrouter-stub.mjs & STUB_PID=$!

if [ "$PROVIDER" = cloudflared ]; then
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$LOG" 2>&1 & TUN_PID=$!
else
  ngrok http "127.0.0.1:$PORT" --log=stdout >"$LOG" 2>&1 & TUN_PID=$!
fi

URL=""
for _ in $(seq 1 60); do
  if [ "$PROVIDER" = cloudflared ]; then
    URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | head -1 || true)"
  else
    URL="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).tunnels.find(x=>x.public_url.startsWith("https://"));if(t)console.log(t.public_url)}catch{}})' || true)"
  fi
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "the tunnel did not come up in 60 s (for ngrok: is the authtoken saved?)" >&2; exit 1; }

FULL="$URL/$LOAD_STUB_PREFIX"
echo
echo "1) Value for the Vercel variable LOADTEST_MODEL_STUB_URL (copy the whole line after the =):"
echo "LOADTEST_MODEL_STUB_URL=$FULL"
echo
echo "2) Streaming self-check: run this in ANOTHER terminal. Pass = pieces of text arrive one after another over about 6 s;"
echo "   fail = silence for 6 s and then everything at once (the tunnel buffers: stop and tell the controller)."
echo "curl -N -s -w '\\n total %{time_total}s\\n' -H 'content-type: application/json' -d '{\"model\":\"x\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}' '$FULL/api/v1/chat/completions'"
echo
echo "3) Health check and call counter (counter stays 0 until the app is rerouted):"
echo "curl -s $URL/healthz ; curl -s $FULL/__stats"
echo
echo "Keep this terminal open until the run is over. Ctrl-C stops the stub and the tunnel."
wait "$STUB_PID" "$TUN_PID"
