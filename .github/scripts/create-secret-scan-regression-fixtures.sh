#!/usr/bin/env bash
set -euo pipefail

fixture_root="${1:?fixture directory is required}"
rm -rf "$fixture_root"
mkdir -p "$fixture_root/docs" "$fixture_root/tests"

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
