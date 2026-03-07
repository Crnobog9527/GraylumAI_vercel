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
ENV_FILE="$ROOT_DIR/.env.local"

if [[ "${1:-}" == "--with-security" ]]; then
  WITH_SECURITY=1
fi

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

STEP_RESULTS=""

copy_template "$ROOT_DIR/docs/refactor-parity/templates/old-site-baseline.template.md" \
  "$MANUAL_DIR/01-old-site-baseline.md"
copy_template "$ROOT_DIR/docs/refactor-parity/templates/function-comparison-matrix.template.md" \
  "$MANUAL_DIR/02-function-comparison-matrix.md"
copy_template "$ROOT_DIR/docs/refactor-parity/templates/issue-list.template.md" \
  "$MANUAL_DIR/03-issue-list.md"

run_step "api-tests" pnpm test:api
run_step "critical-e2e" pnpm --dir apps/web test:e2e:critical

if [[ "$WITH_SECURITY" -eq 1 ]]; then
  run_step "full-e2e" pnpm --dir apps/web test:e2e
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
  printf '%s\n' "- user_e2e_credentials_ready: \`$USER_E2E_READY\`"
  printf '%s\n' "- admin_e2e_credentials_ready: \`$ADMIN_E2E_READY\`"
  printf '%s\n' "- security_suite_included: \`$([[ "$WITH_SECURITY" -eq 1 ]] && printf 'yes' || printf 'no')\`"
  printf '\n%s\n\n' '## Command Results'
  printf '%b' "$STEP_RESULTS"
  printf '\n%s\n\n' '## Evidence Paths'
  printf '%s\n' '- API logs: `logs/api-tests.log`'
  printf '%s\n' '- Critical E2E logs: `logs/critical-e2e.log`'
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
  printf '%s\n' '4. Treat skipped Playwright flows due to missing E2E credentials as a readiness gap, not as a pass.'
} > "$RESULTS_FILE"

printf '\nAudit output ready: %s\n' "$RUN_DIR"
