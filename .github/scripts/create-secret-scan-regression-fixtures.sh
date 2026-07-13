#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "${1:-}" ]]; then
  printf 'fixture directory is required\n' >&2
  exit 1
fi

requested_root="$1"
case "$requested_root" in
  /|.|..)
    printf 'refusing dangerous fixture directory: %s\n' "$requested_root" >&2
    exit 1
    ;;
esac

case "$requested_root" in
  /*) ;;
  *) requested_root="$PWD/$requested_root" ;;
esac

fixture_parent="${requested_root%/*}"
fixture_name="${requested_root##*/}"
if [[ ! -d "$fixture_parent" || -z "$fixture_name" ]]; then
  printf 'fixture parent must already exist\n' >&2
  exit 1
fi

fixture_parent="$(cd "$fixture_parent" && pwd -P)"
fixture_root="$fixture_parent/$fixture_name"
temp_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
repo_root="$(cd "$repo_root" && pwd -P)"

if [[ -e "$fixture_root" || -L "$fixture_root" ]]; then
  printf 'fixture directory must not already exist\n' >&2
  exit 1
fi

case "$fixture_root" in
  "$temp_root"/graylum-secret-scan-fixtures.*) ;;
  *)
    printf 'fixture directory must be a dedicated Graylum temporary directory\n' >&2
    exit 1
    ;;
esac

if [[ "$fixture_root" == "$repo_root" || "$fixture_root" == "$repo_root/"* ]]; then
  printf 'fixture directory must not be inside the repository\n' >&2
  exit 1
fi

if [[ -n "${GITHUB_WORKSPACE:-}" && -d "$GITHUB_WORKSPACE" ]]; then
  workspace_root="$(cd "$GITHUB_WORKSPACE" && pwd -P)"
  if [[ "$fixture_root" == "$workspace_root" || "$fixture_root" == "$workspace_root/"* ]]; then
    printf 'fixture directory must not be inside GITHUB_WORKSPACE\n' >&2
    exit 1
  fi
fi

created_fixture_root=false
cleanup_on_error() {
  status=$?
  if [[ $status -ne 0 && "$created_fixture_root" == true ]]; then
    rm -rf "$fixture_root"
  fi
  exit "$status"
}
trap cleanup_on_error EXIT

mkdir -m 700 "$fixture_root"
created_fixture_root=true
mkdir "$fixture_root/docs" "$fixture_root/tests"

generated_marker='INVALID_GENERATED_REGRESSION_VALUE'

printf 'openai_new=%s%s\n' 'sk-proj-' "${generated_marker}OpenAINew0123456789" \
  > "$fixture_root/docs/generated-openai-new.md"
printf 'openai_legacy=%s%s\n' 'sk-' 'InvalidGeneratedOpenAILegacy0123456789' \
  > "$fixture_root/tests/generated-openai-legacy.test.ts"
printf 'stripe=%s%s\n' 'sk_test_' 'InvalidGeneratedStripe0123456789' \
  > "$fixture_root/tests/generated-stripe.test.ts"
printf '%s=%s\n' 'VERCEL_TOKEN' 'InvalidGeneratedVercelToken0123456789' \
  > "$fixture_root/docs/generated-vercel-token.md"
printf '%s=%s.%s.%s\n' \
  'SUPABASE_SERVICE_ROLE_KEY' \
  'eyJInvalidGeneratedHeader012345' \
  'eyJInvalidGeneratedServiceRolePayload012345' \
  'InvalidGeneratedSignature0123456789' \
  > "$fixture_root/tests/generated-supabase-service-role.test.ts"
printf 'openrouter=%s%s\n' 'sk-or-v1-' 'InvalidGeneratedOpenRouter0123456789' \
  > "$fixture_root/docs/generated-openrouter.md"

trap - EXIT
