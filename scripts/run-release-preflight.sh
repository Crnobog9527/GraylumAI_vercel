#!/usr/bin/env bash
# Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
# The browser rehearsal owns an ephemeral local stack; never run the old write suites on a shared deployment.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
OUTPUT_ROOT="$ROOT_DIR/.release-output/preflight"
RUN_DIR="$(mktemp -d "$OUTPUT_ROOT/run-XXXXXXXX" 2>/dev/null || { mkdir -p "$OUTPUT_ROOT"; mktemp -d "$OUTPUT_ROOT/run-XXXXXXXX"; })"
mkdir -p "$RUN_DIR/logs"
SUMMARY_FILE="$RUN_DIR/00-release-preflight-summary.md"
WITH_PREVIEW=0
LOCAL_ONLY=0
REMOTE_REQUESTED=0
SKIP_LOCAL_BUILD=0
WITH_ADMIN_DESTRUCTIVE=0
INVALID=''
PREVIEW_URL_ARG=''
STAGING_WORKDIR=''
if [[ -n "${PREVIEW_URL:-}" || -n "${PLAYWRIGHT_BASE_URL:-}" || -n "${VERCEL_BYPASS_COOKIE:-}" ||
      -n "${DATABASE_URL:-}" || -n "${NEXT_PUBLIC_SUPABASE_URL:-}" || -n "${TURN_DATABASE_HOST:-}" ]]; then
  INVALID='External target or bypass credentials supplied; only the owned local rehearsal is supported.'
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-preview) WITH_PREVIEW=1; REMOTE_REQUESTED=1; shift ;;
    --local-only) WITH_PREVIEW=1; LOCAL_ONLY=1; shift ;;
    --with-admin-destructive) WITH_ADMIN_DESTRUCTIVE=1; shift ;;
    --skip-local-build) SKIP_LOCAL_BUILD=1; shift ;;
    --preview-url) PREVIEW_URL_ARG="${2:-}"; shift; [[ $# -gt 0 ]] && shift ;;
    --staging-workdir) STAGING_WORKDIR="${2:-}"; shift; [[ $# -gt 0 ]] && shift ;;
    --bypass-cookie) INVALID='Bypass credentials are not accepted.'; shift; [[ $# -gt 0 ]] && shift ;;
    -h|--help) echo 'Usage: run-release-preflight.sh [--with-preview|--local-only] [--with-admin-destructive] [--skip-local-build]'
      echo '--local-only validates the isolated rehearsal; --with-preview also requires a remote target check.'; exit 0 ;;
    *) INVALID="Unknown option: $1"; shift ;;
  esac
done
if [[ "$LOCAL_ONLY" == 1 && "$REMOTE_REQUESTED" == 1 ]]; then
  INVALID='--local-only and --with-preview cannot be combined'
elif [[ "$REMOTE_REQUESTED" == 1 && ( "$PREVIEW_URL_ARG" != 'https://auth-staging.graylum.com' || -z "$STAGING_WORKDIR" ) ]]; then
  INVALID='--with-preview requires the approved staging URL and linked staging workdir'
elif [[ "$REMOTE_REQUESTED" == 1 && "$(cat "$STAGING_WORKDIR/supabase/.temp/project-ref" 2>/dev/null || true)" != 'gvcpmcunmfrbxuwimxfa' ]]; then
  INVALID='staging workdir is not linked to the approved test project'
elif [[ "$REMOTE_REQUESTED" != 1 && ( -n "$PREVIEW_URL_ARG" || -n "$STAGING_WORKDIR" ) ]]; then
  INVALID='staging arguments require --with-preview'
fi
results=()
failed=0
record() { results+=("- $1: $2${3:+ ($3)}"); [[ "$2" == passed ]] || failed=1; }
finish() {
  {
    echo '# Release Preflight Summary'
    echo
    echo 'The browser rehearsal uses a disposable local database and simulated providers; it does not establish production readiness.'
    echo 'Stripe account and balance reads use a local synthetic service; real Stripe connectivity and payments are not tested.'
    echo 'Attachment storage is simulated in memory; real Storage access controls and signed downloads are not tested.'
    echo
    echo '## Step Results'
    printf '%s\n' "${results[@]}"
    if [[ -f "$RUN_DIR/logs/isolated-rehearsal.log" ]]; then
      for suite in chat home-routing auth admin admin-config admin-ops security user-extended user-supplemental; do
        line=$(grep -F "release suite $suite:" "$RUN_DIR/logs/isolated-rehearsal.log" | tail -1 || true)
        printf -- '- %s\n' "${line:-release suite $suite: not-run}"
      done
      if [[ "$WITH_ADMIN_DESTRUCTIVE" == 1 ]]; then
        line=$(grep -F 'release suite admin-destructive:' "$RUN_DIR/logs/isolated-rehearsal.log" | tail -1 || true)
        printf -- '- %s\n' "${line:-release suite admin-destructive: not-run}"
      fi
    fi
    echo
    if [[ -f "$RUN_DIR/logs/remote-preview.log" ]]; then
      while IFS= read -r line; do printf -- '- %s\n' "$line"; done < "$RUN_DIR/logs/remote-preview.log"
    fi
    echo '- runtime binding is not verified unless an authoritative deployment source establishes it'
    echo '- Stripe, real providers and production configuration: not-run'
    echo '- long-text confirmation: retired by Owner decision; current input-length protection is checked in the steps above'
    echo '- risk acceptance: not evaluated'
    echo 'These items require separate evidence; no conclusion is inferred here.'
  } > "$SUMMARY_FILE"
  printf '%s\n' "$RUN_DIR" > "$OUTPUT_ROOT/latest-run.txt"
  echo "Release preflight summary: $SUMMARY_FILE"
  exit "$failed"
}
clean_env=(env -i "PATH=$PATH" "HOME=$HOME" NEXT_TELEMETRY_DISABLED=1)
[[ -n "${PNPM_HOME:-}" ]] && clean_env+=("PNPM_HOME=$PNPM_HOME")
step() {
  local name="$1"; shift
  local ok=0
  "${clean_env[@]}" "$@" > "$RUN_DIR/logs/$name.log" 2>&1 || ok=1
  if [[ "$name" == remote-preview ]]; then
    local required
    for required in 'staging-target: passed' 'deployment-project: passed' 'deployment-identity: passed' \
      'deployment-version: passed' 'staging-maintenance: passed' 'runtime-binding: passed'; do
      grep -Fq "$required" "$RUN_DIR/logs/$name.log" || ok=1
    done
  fi
  if [[ "$name" == isolated-rehearsal ]]; then
    local suite
    local suites=(chat home-routing auth admin admin-config admin-ops security user-extended user-supplemental)
    [[ "$WITH_ADMIN_DESTRUCTIVE" == 1 ]] && suites+=(admin-destructive)
    for suite in "${suites[@]}"; do
      suffix=''
      [ "$suite" != user-extended ] || suffix=' [checkout display uses simulated reads, not payment integration]'
      grep -Fxq "release suite $suite: passed (skipped: 0)$suffix" "$RUN_DIR/logs/$name.log" || ok=1
    done
  fi
  if [[ "$ok" == 0 ]]; then record "$name" passed "logs/$name.log"; else record "$name" failed "logs/$name.log"; fi
}
if [[ -n "$INVALID" ]]; then
  record configuration failed "$INVALID"
  record typecheck not-run 'configuration failed'
  record build not-run 'configuration failed'
  record chat-input-ui not-run 'configuration failed'
  record chat-input-api not-run 'configuration failed'
  record isolated-rehearsal not-run 'configuration failed'
  record remote-preview not-run 'configuration failed'
  finish
fi
for dir in . apps/web; do
 for name in .env .env.local .env.development .env.development.local .env.production .env.production.local .env.test .env.test.local; do
  file="$dir/$name"
  if [[ -e "$file" ]]; then
    record configuration failed "environment file present: $file; use a clean isolated checkout"
    record typecheck not-run 'configuration failed'
    record build not-run 'configuration failed'
    record chat-input-ui not-run 'configuration failed'
    record chat-input-api not-run 'configuration failed'
    record isolated-rehearsal not-run 'configuration failed'
    finish
  fi
 done
done
if [[ "$REMOTE_REQUESTED" == 1 ]] && ! "${clean_env[@]}" node scripts/release-staging-readonly.mjs \
  --staging-workdir "$STAGING_WORKDIR" --validate-only > "$RUN_DIR/logs/staging-target.log" 2>&1; then
  record configuration failed 'staging link or pooler target is invalid'
  record typecheck not-run 'configuration failed'
  record build not-run 'configuration failed'
  record chat-input-ui not-run 'configuration failed'
  record chat-input-api not-run 'configuration failed'
  record isolated-rehearsal not-run 'configuration failed'
  record remote-preview not-run 'configuration failed'
  finish
fi
record configuration passed 'clean checkout; inherited application environment removed'
step typecheck pnpm --dir apps/web typecheck
step chat-input-ui pnpm --filter web exec vitest run src/components/opc/composer-editor.browser.test.tsx \
  'src/app/(zh-hans)/app/runtime/turn-notices.test.ts' 'src/app/(zh-hans)/app/runtime/gate-notices.test.ts' \
  'src/app/(zh-hans)/app/runtime/use-turn-chat.test.ts' --config vitest.config.ts
step chat-input-api pnpm --filter @repo/api exec vitest run src/services/turn/bodyBound.test.ts
if [[ "$SKIP_LOCAL_BUILD" == 1 ]]; then record build skipped '--skip-local-build'; else step build pnpm build; fi
if [[ "$WITH_PREVIEW" != 1 ]]; then
  record isolated-rehearsal not-run 'requires --with-preview'
elif [[ "$WITH_ADMIN_DESTRUCTIVE" == 1 ]]; then
  step isolated-rehearsal node scripts/e2e-sim/run.mjs --release-preflight --with-admin-destructive
else
  step isolated-rehearsal node scripts/e2e-sim/run.mjs --release-preflight
  results+=("- admin-destructive: skipped (optional; enable only in disposable local stack)")
fi
if [[ "$LOCAL_ONLY" == 1 ]]; then
  results+=("- remote-preview: not-run (outside local-only scope)")
elif [[ "$REMOTE_REQUESTED" == 1 ]]; then
  step remote-preview node scripts/release-staging-readonly.mjs --staging-workdir "$STAGING_WORKDIR"
else
  record remote-preview not-run 'requires --with-preview and approved staging inputs'
fi
finish
