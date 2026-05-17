#!/usr/bin/env bash
# Copyright (c) 2026 Grayscale Luminary LLC.
# All rights reserved.
# This code is proprietary and confidential.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_ROOT="$ROOT_DIR/.release-output/preflight"
TIMESTAMP="$(date +"%Y%m%d-%H%M%S")"
RUN_DIR="$OUTPUT_ROOT/$TIMESTAMP"
LOG_DIR="$RUN_DIR/logs"
EVIDENCE_DIR="$RUN_DIR/evidence"
PREVIEW_REPORT_DIR="$EVIDENCE_DIR/playwright-preview"
SUMMARY_FILE="$RUN_DIR/00-release-preflight-summary.md"

WITH_PREVIEW=0
WITH_ADMIN_DESTRUCTIVE=0
SKIP_LOCAL_BUILD=0
PREVIEW_URL="${PREVIEW_URL:-}"
BYPASS_COOKIE="${VERCEL_BYPASS_COOKIE:-}"

mkdir -p "$LOG_DIR" "$PREVIEW_REPORT_DIR"

usage() {
  cat <<'EOF'
Usage: bash ./scripts/run-release-preflight.sh [options]

Options:
  --with-preview                Run preview/staging rehearsal suites.
  --preview-url <url>           Locked preview/staging base URL.
  --bypass-cookie <cookie>      Deployment Protection bypass cookie.
  --with-admin-destructive      Include isolated destructive admin suite.
  --skip-local-build            Skip local pnpm build.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --with-preview)
      WITH_PREVIEW=1
      shift
      ;;
    --preview-url)
      PREVIEW_URL="${2:-}"
      shift 2
      ;;
    --bypass-cookie)
      BYPASS_COOKIE="${2:-}"
      shift 2
      ;;
    --with-admin-destructive)
      WITH_ADMIN_DESTRUCTIVE=1
      shift
      ;;
    --skip-local-build)
      SKIP_LOCAL_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

STEP_RESULTS=""

run_step() {
  local step_name="$1"
  shift

  local log_file="$LOG_DIR/${step_name}.log"
  local status="failed"

  printf '## %s\n' "$step_name" > "$log_file"
  printf 'Command: %s\n\n' "$*" >> "$log_file"

  if "$@" 2>&1 | tee -a "$log_file"; then
    status="passed"
  fi

  STEP_RESULTS="${STEP_RESULTS}- ${step_name}: ${status} (log: logs/${step_name}.log)\n"
}

run_preview_step() {
  local step_name="$1"
  shift

  local log_file="$LOG_DIR/${step_name}.log"
  local status="failed"

  printf '## %s\n' "$step_name" > "$log_file"
  printf 'Preview URL: %s\n' "$PREVIEW_URL" >> "$log_file"
  printf 'Command: PLAYWRIGHT_BASE_URL=%s VERCEL_BYPASS_COOKIE=<redacted> %s\n\n' "$PREVIEW_URL" "$*" >> "$log_file"

  if PLAYWRIGHT_BASE_URL="$PREVIEW_URL" VERCEL_BYPASS_COOKIE="$BYPASS_COOKIE" "$@" 2>&1 | tee -a "$log_file"; then
    status="passed"
  fi

  STEP_RESULTS="${STEP_RESULTS}- ${step_name}: ${status} (log: logs/${step_name}.log)\n"
}

run_preview_normalization() {
  local step_name="$1"
  local log_file="$LOG_DIR/${step_name}.log"
  local status="failed"

  printf '## %s\n' "$step_name" > "$log_file"
  printf 'Preview URL: %s\n' "$PREVIEW_URL" >> "$log_file"
  printf 'Command: pnpm --dir apps/web exec node ../../scripts/ensure-preview-ready.mjs --preview-url %s --bypass-cookie <redacted> --admin-state tests/e2e/.auth/admin.json\n\n' "$PREVIEW_URL" >> "$log_file"

  if pnpm --dir apps/web exec node ../../scripts/ensure-preview-ready.mjs --preview-url "$PREVIEW_URL" --bypass-cookie "$BYPASS_COOKIE" --admin-state tests/e2e/.auth/admin.json 2>&1 | tee -a "$log_file"; then
    status="passed"
  fi

  STEP_RESULTS="${STEP_RESULTS}- ${step_name}: ${status} (log: logs/${step_name}.log)\n"
}

write_summary() {
  {
    echo "# Release Preflight Summary"
    echo
    echo "- Generated at: \`$TIMESTAMP\`"
    echo "- Run directory: \`.release-output/preflight/$TIMESTAMP\`"
    echo "- Preview rehearsal requested: \`$([[ "$WITH_PREVIEW" -eq 1 ]] && echo yes || echo no)\`"
    if [[ -n "$PREVIEW_URL" ]]; then
      echo "- Locked preview URL: \`$PREVIEW_URL\`"
    fi
    echo
    echo "## Step Results"
    printf "%b" "$STEP_RESULTS"
    echo
    echo "## Accepted Risk"
    echo "- Supabase 免费套餐暂不支持 leaked password protection；该项保留为 accepted risk。"
    echo
    echo "## Stripe"
    echo "- 本次 preflight 不启用 Stripe。"
    echo "- Stripe 接入后需单独补跑 checkout / cancel / fail / webhook 幂等 / 到账核对。"
  } > "$SUMMARY_FILE"
}

run_step "typecheck" pnpm --dir apps/web typecheck

if [[ "$SKIP_LOCAL_BUILD" -eq 0 ]]; then
  run_step "build" pnpm build
else
  STEP_RESULTS="${STEP_RESULTS}- build: skipped (--skip-local-build)\n"
fi

if [[ "$WITH_PREVIEW" -eq 1 ]]; then
  if [[ -z "$PREVIEW_URL" ]]; then
    STEP_RESULTS="${STEP_RESULTS}- preview-config: failed (missing --preview-url or PREVIEW_URL)\n"
  else
    if [[ -z "$BYPASS_COOKIE" ]]; then
      STEP_RESULTS="${STEP_RESULTS}- preview-config: passed (no bypass cookie; assuming unprotected preview)\n"
    else
      STEP_RESULTS="${STEP_RESULTS}- preview-config: passed (bypass cookie configured)\n"
    fi

    run_preview_step "preview-auth" pnpm --dir apps/web exec playwright test tests/e2e/auth.spec.ts --project=chromium
    run_preview_normalization "preview-ready"
    run_preview_step "preview-chat" pnpm --dir apps/web exec playwright test tests/e2e/chat.spec.ts --project=chromium
    run_preview_step "preview-admin" pnpm --dir apps/web exec playwright test tests/e2e/admin.spec.ts --project=chromium
    run_preview_step "preview-admin-config" pnpm --dir apps/web test:e2e:admin-config
    run_preview_step "preview-admin-ops" pnpm --dir apps/web test:e2e:admin-ops
    run_preview_step "preview-security" pnpm --dir apps/web exec playwright test tests/e2e/security.spec.ts --project=chromium
    run_preview_step "preview-user-extended" pnpm --dir apps/web test:e2e:user-extended
    run_preview_step "preview-user-supplemental" pnpm --dir apps/web test:e2e:user-supplemental

    if [[ "$WITH_ADMIN_DESTRUCTIVE" -eq 1 ]]; then
      run_preview_step "preview-admin-destructive" env ENABLE_PARITY_DESTRUCTIVE_E2E=true pnpm --dir apps/web test:e2e:admin-destructive
    else
      STEP_RESULTS="${STEP_RESULTS}- preview-admin-destructive: skipped (enable with --with-admin-destructive)\n"
    fi
  fi
else
  STEP_RESULTS="${STEP_RESULTS}- preview-rehearsal: skipped (--with-preview not set)\n"
fi

write_summary
printf '%s\n' "$RUN_DIR" > "$OUTPUT_ROOT/latest-run.txt"

echo
echo "Release preflight summary written to: $SUMMARY_FILE"
