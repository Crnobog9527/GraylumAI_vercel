#!/usr/bin/env bash
# Copyright (c) 2026 Grayscale Luminary LLC.
# All rights reserved.
# This code is proprietary and confidential.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_ROOT="$ROOT_DIR/.audit-output/refactor-parity"
TIMESTAMP="$(date +"%Y%m%d-%H%M%S")"
RUN_DIR="$OUTPUT_ROOT/$TIMESTAMP"
LOG_DIR="$RUN_DIR/logs"
EVIDENCE_DIR="$RUN_DIR/evidence"
MANUAL_DIR="$RUN_DIR/manual"
PLAYWRIGHT_DIR="$EVIDENCE_DIR/playwright"
WITH_SECURITY=0
WITH_EXTENDED=0
WITH_USER_EXTENDED=0
WITH_ADMIN_CONFIG=0
WITH_ADMIN_OPS=0
WITH_ADMIN_DESTRUCTIVE=0
ENV_FILE="$ROOT_DIR/.env.local"
PREVIEW_URL=""
BYPASS_COOKIE=""
REMOTE_E2E_READY=0

for arg in "$@"; do
  case "$arg" in
    --with-security)
      WITH_SECURITY=1
      ;;
    --with-extended)
      WITH_EXTENDED=1
      ;;
    --with-user-extended)
      WITH_USER_EXTENDED=1
      ;;
    --with-admin-config)
      WITH_ADMIN_CONFIG=1
      ;;
    --with-admin-ops)
      WITH_ADMIN_OPS=1
      ;;
    --with-admin-destructive)
      WITH_ADMIN_DESTRUCTIVE=1
      ;;
  esac
done

mkdir -p "$LOG_DIR" "$PLAYWRIGHT_DIR" "$MANUAL_DIR"

copy_template() {
  local source_path="$1"
  local target_path="$2"
  cp "$source_path" "$target_path"
}

copy_if_exists() {
  local source_path="$1"
  local target_path="$2"
  if [[ -e "$source_path" ]]; then
    rm -rf "$target_path"
    cp -R "$source_path" "$target_path"
  fi
}

env_key_configured() {
  local key="$1"

  if [[ -n "${!key:-}" ]]; then
    return 0
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    return 1
  fi

  rg -q "^${key}=.+" "$ENV_FILE"
}

run_step() {
  local step_name="$1"
  shift

  local log_file="$LOG_DIR/${step_name}.log"
  local status

  printf '## %s\n' "$step_name" > "$log_file"
  printf 'Command: %s\n\n' "$*" >> "$log_file"

  if "$@" 2>&1 | tee -a "$log_file"; then
    status="passed"
  else
    status="failed"
  fi

  STEP_RESULTS="${STEP_RESULTS}- ${step_name}: ${status} (log: logs/${step_name}.log)\n"
}

run_vercel_deploy() {
  local step_name="vercel-preview"
  local log_file="$LOG_DIR/${step_name}.log"
  local output_file="$RUN_DIR/preview-url.txt"
  local status="failed"

  printf '## %s\n' "$step_name" > "$log_file"
  printf 'Command: (cd repo-root && vercel deploy -y)\n\n' >> "$log_file"

  local deploy_output
  if deploy_output="$(
    cd "$ROOT_DIR" &&
      vercel deploy -y 2>&1
  )"; then
    printf '%s\n' "$deploy_output" | tee -a "$log_file" >/dev/null
    PREVIEW_URL="$(printf '%s\n' "$deploy_output" | rg -o 'https://[[:alnum:].-]+\.vercel\.app' | tail -n 1)"

    if [[ -n "$PREVIEW_URL" ]]; then
      printf '%s\n' "$PREVIEW_URL" > "$output_file"
      status="passed"
    else
      printf '\nFailed to parse preview URL from deploy output.\n' | tee -a "$log_file" >/dev/null
    fi
  else
    printf '%s\n' "$deploy_output" | tee -a "$log_file" >/dev/null
  fi

  STEP_RESULTS="${STEP_RESULTS}- ${step_name}: ${status} (log: logs/${step_name}.log)\n"

  if [[ "$status" != "passed" ]]; then
    return 1
  fi
}

run_playwright_step() {
  local step_name="$1"
  shift

  local log_file="$LOG_DIR/${step_name}.log"
  local status

  printf '## %s\n' "$step_name" > "$log_file"
  printf 'Command: PLAYWRIGHT_BASE_URL=%s VERCEL_BYPASS_COOKIE=<redacted> %s\n\n' "$PREVIEW_URL" "$*" >> "$log_file"

  if PLAYWRIGHT_BASE_URL="$PREVIEW_URL" VERCEL_BYPASS_COOKIE="$BYPASS_COOKIE" "$@" 2>&1 | tee -a "$log_file"; then
    status="passed"
  else
    status="failed"
  fi

  STEP_RESULTS="${STEP_RESULTS}- ${step_name}: ${status} (log: logs/${step_name}.log)\n"
}

fetch_vercel_bypass_cookie() {
  local step_name="vercel-bypass"
  local log_file="$LOG_DIR/${step_name}.log"
  local bypass_output=""
  local status="failed"
  local attempt=1
  local max_attempts=5

  printf '## %s\n' "$step_name" > "$log_file"
  printf 'Command: vercel curl /login?x-vercel-set-bypass-cookie=true --deployment <preview-url> -- --include (with retries)\n\n' >> "$log_file"

  while [[ "$attempt" -le "$max_attempts" ]]; do
    printf 'Attempt %s/%s\n' "$attempt" "$max_attempts" >> "$log_file"

    if bypass_output="$(
      vercel curl '/login?x-vercel-set-bypass-cookie=true' --deployment "$PREVIEW_URL" -- --include 2>&1
    )"; then
      BYPASS_COOKIE="$(
        printf '%s\n' "$bypass_output" |
          tr -d '\r' |
          sed -n 's/^set-cookie: _vercel_jwt=\([^;]*\).*/\1/p' |
          head -n 1
      )"

      if [[ -n "$BYPASS_COOKIE" ]]; then
        printf '%s\n' 'Bypass cookie acquired for preview deployment.' >> "$log_file"
        status="passed"
        break
      fi

      printf '%s\n' 'Failed to parse bypass cookie from Vercel response.' >> "$log_file"
    else
      printf '%s\n' "$bypass_output" | sed 's/_vercel_jwt=[^;]*/_vercel_jwt=<redacted>/' >> "$log_file"
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      printf '%s\n' 'Retrying bypass bootstrap after 5 seconds...' >> "$log_file"
      sleep 5
    fi

    attempt=$((attempt + 1))
  done

  STEP_RESULTS="${STEP_RESULTS}- ${step_name}: ${status} (log: logs/${step_name}.log)\n"

  if [[ "$status" != "passed" ]]; then
    return 1
  fi
}

STEP_RESULTS=""

copy_template "$ROOT_DIR/docs/refactor-parity/templates/old-site-baseline.template.md" \
  "$MANUAL_DIR/01-old-site-baseline.md"
copy_template "$ROOT_DIR/docs/refactor-parity/templates/function-comparison-matrix.template.md" \
  "$MANUAL_DIR/02-function-comparison-matrix.md"
copy_template "$ROOT_DIR/docs/refactor-parity/templates/issue-list.template.md" \
  "$MANUAL_DIR/03-issue-list.md"

run_step "api-tests" pnpm test:api
if run_vercel_deploy && fetch_vercel_bypass_cookie; then
  REMOTE_E2E_READY=1
  run_playwright_step "critical-e2e" pnpm --dir apps/web test:e2e:critical
  if [[ "$WITH_EXTENDED" -eq 1 ]]; then
    run_playwright_step "extended-e2e" pnpm --dir apps/web test:e2e:parity:extended
  fi
  if [[ "$WITH_USER_EXTENDED" -eq 1 ]]; then
    run_playwright_step "user-extended-e2e" pnpm --dir apps/web test:e2e:user-extended
  fi
  if [[ "$WITH_ADMIN_CONFIG" -eq 1 ]]; then
    run_playwright_step "admin-config-e2e" pnpm --dir apps/web test:e2e:admin-config
  fi
  if [[ "$WITH_ADMIN_OPS" -eq 1 ]]; then
    run_playwright_step "admin-ops-e2e" pnpm --dir apps/web test:e2e:admin-ops
  fi
  if [[ "$WITH_ADMIN_DESTRUCTIVE" -eq 1 ]]; then
    run_playwright_step "admin-destructive-e2e" pnpm --dir apps/web test:e2e:admin-destructive
  fi
else
  STEP_RESULTS="${STEP_RESULTS}- critical-e2e: skipped (preview deploy or bypass bootstrap failed; local fallback disabled)\n"
  if [[ "$WITH_EXTENDED" -eq 1 ]]; then
    STEP_RESULTS="${STEP_RESULTS}- extended-e2e: skipped (preview deploy or bypass bootstrap failed; local fallback disabled)\n"
  fi
  if [[ "$WITH_USER_EXTENDED" -eq 1 ]]; then
    STEP_RESULTS="${STEP_RESULTS}- user-extended-e2e: skipped (preview deploy or bypass bootstrap failed; local fallback disabled)\n"
  fi
  if [[ "$WITH_ADMIN_CONFIG" -eq 1 ]]; then
    STEP_RESULTS="${STEP_RESULTS}- admin-config-e2e: skipped (preview deploy or bypass bootstrap failed; local fallback disabled)\n"
  fi
  if [[ "$WITH_ADMIN_OPS" -eq 1 ]]; then
    STEP_RESULTS="${STEP_RESULTS}- admin-ops-e2e: skipped (preview deploy or bypass bootstrap failed; local fallback disabled)\n"
  fi
  if [[ "$WITH_ADMIN_DESTRUCTIVE" -eq 1 ]]; then
    STEP_RESULTS="${STEP_RESULTS}- admin-destructive-e2e: skipped (preview deploy or bypass bootstrap failed; local fallback disabled)\n"
  fi
fi

if [[ "$WITH_SECURITY" -eq 1 && "$REMOTE_E2E_READY" -eq 1 ]]; then
  run_playwright_step "full-e2e" pnpm --dir apps/web test:e2e
elif [[ "$WITH_SECURITY" -eq 1 ]]; then
  STEP_RESULTS="${STEP_RESULTS}- full-e2e: skipped (preview deploy or bypass bootstrap failed; local fallback disabled)\n"
fi

copy_if_exists "$ROOT_DIR/apps/web/test-results" "$PLAYWRIGHT_DIR/test-results"
copy_if_exists "$ROOT_DIR/apps/web/playwright-report" "$PLAYWRIGHT_DIR/playwright-report"

USER_E2E_READY="no"
ADMIN_E2E_READY="no"
if env_key_configured "E2E_TEST_EMAIL" && env_key_configured "E2E_TEST_PASSWORD"; then
  USER_E2E_READY="yes"
fi
if env_key_configured "E2E_ADMIN_EMAIL" && env_key_configured "E2E_ADMIN_PASSWORD"; then
  ADMIN_E2E_READY="yes"
fi

LATEST_FILE="$OUTPUT_ROOT/latest-run.txt"
mkdir -p "$OUTPUT_ROOT"
printf '%s\n' "$RUN_DIR" > "$LATEST_FILE"

RESULTS_FILE="$RUN_DIR/00-command-results.md"
{
  printf '%s\n\n' '# Refactor Parity Audit Run'
  printf '%s\n' "- generated_at: \`$TIMESTAMP\`"
  printf '%s\n' "- run_dir: \`$RUN_DIR\`"
  printf '%s\n' "- preview_url: \`${PREVIEW_URL:-not-available}\`"
  printf '%s\n' "- user_e2e_credentials_ready: \`$USER_E2E_READY\`"
  printf '%s\n' "- admin_e2e_credentials_ready: \`$ADMIN_E2E_READY\`"
  printf '%s\n' "- extended_suite_included: \`$([[ "$WITH_EXTENDED" -eq 1 ]] && printf 'yes' || printf 'no')\`"
  printf '%s\n' "- user_extended_suite_included: \`$([[ "$WITH_USER_EXTENDED" -eq 1 ]] && printf 'yes' || printf 'no')\`"
  printf '%s\n' "- admin_config_suite_included: \`$([[ "$WITH_ADMIN_CONFIG" -eq 1 ]] && printf 'yes' || printf 'no')\`"
  printf '%s\n' "- admin_ops_suite_included: \`$([[ "$WITH_ADMIN_OPS" -eq 1 ]] && printf 'yes' || printf 'no')\`"
  printf '%s\n' "- admin_destructive_suite_included: \`$([[ "$WITH_ADMIN_DESTRUCTIVE" -eq 1 ]] && printf 'yes' || printf 'no')\`"
  printf '%s\n' "- security_suite_included: \`$([[ "$WITH_SECURITY" -eq 1 ]] && printf 'yes' || printf 'no')\`"
  printf '\n%s\n\n' '## Command Results'
  printf '%b' "$STEP_RESULTS"
  printf '\n%s\n\n' '## Evidence Paths'
  printf '%s\n' '- Preview URL: `preview-url.txt`'
  printf '%s\n' '- Preview deploy log: `logs/vercel-preview.log`'
  printf '%s\n' '- Preview bypass log: `logs/vercel-bypass.log`'
  printf '%s\n' '- API logs: `logs/api-tests.log`'
  printf '%s\n' '- Critical E2E logs: `logs/critical-e2e.log`'
  if [[ "$WITH_EXTENDED" -eq 1 ]]; then
    printf '%s\n' '- Extended E2E logs: `logs/extended-e2e.log`'
  fi
  if [[ "$WITH_USER_EXTENDED" -eq 1 ]]; then
    printf '%s\n' '- User Extended E2E logs: `logs/user-extended-e2e.log`'
  fi
  if [[ "$WITH_ADMIN_CONFIG" -eq 1 ]]; then
    printf '%s\n' '- Admin Config E2E logs: `logs/admin-config-e2e.log`'
  fi
  if [[ "$WITH_ADMIN_OPS" -eq 1 ]]; then
    printf '%s\n' '- Admin Ops E2E logs: `logs/admin-ops-e2e.log`'
  fi
  if [[ "$WITH_ADMIN_DESTRUCTIVE" -eq 1 ]]; then
    printf '%s\n' '- Admin Destructive E2E logs: `logs/admin-destructive-e2e.log`'
  fi
  if [[ "$WITH_SECURITY" -eq 1 ]]; then
    printf '%s\n' '- Full E2E logs: `logs/full-e2e.log`'
  fi
  printf '%s\n' '- Playwright evidence copy: `evidence/playwright/`'
  printf '%s\n' '- Legacy repo baseline template: `manual/01-old-site-baseline.md`'
  printf '%s\n' '- Comparison matrix template: `manual/02-function-comparison-matrix.md`'
  printf '%s\n' '- Issue list template: `manual/03-issue-list.md`'
  printf '\n%s\n\n' '## Next Actions'
  printf '%s\n' '1. Fill the legacy-repo baseline from the old Base44 GitHub repository in `manual/01-old-site-baseline.md`.'
  printf '%s\n' '2. Compare old vs new behavior in `manual/02-function-comparison-matrix.md`.'
  printf '%s\n' '3. Convert every mismatch into a repair-ready ticket in `manual/03-issue-list.md`.'
  printf '%s\n' '4. Reuse the deployed preview URL for any manual browser checks so model and supplier behavior matches the online environment.'
} > "$RESULTS_FILE"

printf '\nAudit output ready: %s\n' "$RUN_DIR"
