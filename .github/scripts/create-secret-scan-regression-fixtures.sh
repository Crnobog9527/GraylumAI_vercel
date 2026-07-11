#!/usr/bin/env bash
set -euo pipefail

fixture_root="${1:?fixture directory is required}"
rm -rf "$fixture_root"
mkdir -p "$fixture_root/docs" "$fixture_root/tests"

openai_prefix='sk-proj-'
stripe_prefix='sk_test_'
printf 'example=%s%s\n' "$openai_prefix" 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' > "$fixture_root/docs/fake-secret.md"
printf 'const key = "%s%s";\n' "$stripe_prefix" 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' > "$fixture_root/tests/fake-secret.test.ts"
