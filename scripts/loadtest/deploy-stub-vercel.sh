#!/usr/bin/env bash
# Deploys the load-test model stub as its own temporary Vercel project (V2-13, 11-04), so the 100-user run's model calls stay inside
# Vercel's network in the staging region instead of crossing a tunnel to the operator's machine (stage 1 on 11-04 lost every stream when
# the tunnelled stub stopped). The project holds no credential and serves nothing without its secret path segment.
#   scripts/loadtest/deploy-stub-vercel.sh <team> [project] [region]     defaults: graylum-loadtest-stub, pdx1
# The full value for LOADTEST_MODEL_STUB_URL (address + secret segment) is written only to ~/graylum-loadtest/stub-url.private
# (mode 0600) and never printed; the script prints the address alone and the result of a streamed self-check through it.
# Afterwards: `vercel project rm <project> --scope <team>` deletes the project (and the stub with it).
set -euo pipefail

TEAM="${1:?usage: deploy-stub-vercel.sh <team> [project] [region]}"
PROJECT="${2:-graylum-loadtest-stub}"
REGION="${3:-pdx1}"
case "$PROJECT" in *loadtest-stub*) ;; *) echo "refusing: the project name must contain loadtest-stub" >&2; exit 1 ;; esac
command -v vercel >/dev/null && command -v openssl >/dev/null && command -v node >/dev/null || { echo "vercel, openssl and node are required" >&2; exit 1; }
cd "$(dirname "$0")/../.."

OUT="$HOME/graylum-loadtest"; mkdir -p "$OUT"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/api"
cp scripts/loadtest/openrouter-stub.mjs "$WORK/openrouter-stub.mjs"   # replaces the repository's re-export file
cp scripts/loadtest/stub-vercel/api/stub.mjs "$WORK/api/stub.mjs"
printf '{"private":true,"type":"module","engines":{"node":"22.x"}}\n' >"$WORK/package.json"
# Every /api/... path goes to the one function, its own path in the query (a plain project gives a catch-all file one segment only).
printf '{"regions":["%s"],"functions":{"api/stub.mjs":{"maxDuration":60}},"rewrites":[{"source":"/api/(.*)","destination":"/api/stub?path=$1"}]}\n' \
  "$REGION" >"$WORK/vercel.json"

PREFIX="$(openssl rand -hex 16)"
vercel link --cwd "$WORK" --yes --project "$PROJECT" --scope "$TEAM" >/dev/null
DEPLOYED="$(vercel deploy --cwd "$WORK" --prod --yes --scope "$TEAM" -e LOAD_STUB_PREFIX="$PREFIX" 2>"$WORK/deploy.log" | tail -1)" \
  || { echo "deploy failed:" >&2; grep -v "$PREFIX" "$WORK/deploy.log" | tail -5 >&2; exit 1; }
[ -n "$DEPLOYED" ] || { echo "the deployment printed no address" >&2; exit 1; }
# The public address is the production alias Vercel gave THIS deployment (a taken name gets a suffix), never a guessed one: the
# secret segment must only ever be sent to our own project.
HOST="$(vercel inspect "$DEPLOYED" --scope "$TEAM" 2>&1 | grep -oE "https://$PROJECT(-[a-z0-9-]+)?\.vercel\.app" | head -1)"
[ -n "$HOST" ] || { echo "no $PROJECT*.vercel.app alias on the deployment; nothing was sent to it" >&2; exit 1; }
rm -f "$OUT/stub-url.private"; (umask 077; printf '%s/api/%s\n' "$HOST" "$PREFIX" >"$OUT/stub-url.private")
echo "deployed: $HOST (region $REGION); full stub URL written to $OUT/stub-url.private"

# Self-check through the public address: health, one streamed reply (pieces must arrive over ~6 s, not all at once), its receipt.
curl -sf "$HOST/api/healthz" >/dev/null || { echo "health check failed (deployment protection on the production domain?)" >&2; exit 1; }
FULL="$(cat "$OUT/stub-url.private")"
node --input-type=module -e '
const base = process.argv[1], started = Date.now(), seen = [];
const r = await fetch(base + "/api/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "x", stream: true, messages: [{ role: "user", content: "hi" }] }) });
const id = r.headers.get("x-generation-id");
for await (const part of r.body) seen.push(Date.now() - started);
const receipt = await fetch(base + "/api/v1/generation?id=" + encodeURIComponent(id));
const spread = seen.at(-1) - seen[0];
console.log(JSON.stringify({ status: r.status, firstByteMs: seen[0], totalMs: seen.at(-1), pieces: seen.length, streamed: spread > 3000,
  receipt: receipt.status }));
if (r.status !== 200 || spread <= 3000 || receipt.status !== 200) process.exit(1);
' "$FULL"
