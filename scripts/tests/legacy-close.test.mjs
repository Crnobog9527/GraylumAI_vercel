/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const [runner, message] of [
  ['run-workbench.mjs', '--agent-slice-only retired by LEGACY-CLOSE'],
  ['run-local.mjs', 'only --research-only or --artifacts-only is supported'],
]) {
  test(`${runner} rejects the retired slice suite instead of reporting an empty pass`, () => {
    const result = spawnSync(process.execPath, [
      `${root}packages/db/tests/v3/${runner}`, '--agent-slice-only',
    ], { cwd: root, env: { PATH: '' }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.equal(result.stdout.includes('LOCAL_EVIDENCE_DIRECTORY'), false);
  });
}
