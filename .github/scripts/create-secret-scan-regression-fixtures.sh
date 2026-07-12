#!/usr/bin/env bash
set -euo pipefail

fixture_root="${1:?fixture directory is required}"
rm -rf "$fixture_root"
mkdir -p "$fixture_root/docs" "$fixture_root/tests"

openai_prefix='sk-proj-'
stripe_prefix='sk_test_'
vercel_name='VERCEL_TOKEN'
printf 'example=%s%s\n' "$openai_prefix" 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' > "$fixture_root/docs/fake-secret.md"
printf 'const key = "%s%s";\n' "$stripe_prefix" 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' > "$fixture_root/tests/fake-secret.test.ts"
printf 'const token = "%s=%s";\n' "$vercel_name" 'Ab3Cd5Ef7Gh9Jk2Lm4Np6Qr8St0Uv1Wx' > "$fixture_root/tests/fake-vercel-token.test.ts"
