/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { previewNames, writePreviewState } from '../../packages/db/tests/v3/preview-lifecycle.mjs';

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

for (const action of ['stop', 'destroy', 'resume', 'restart', 'renew']) {
  test(`saved retired slice preview permits cleanup only: ${action}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-close-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const id = 'retired-slice';
    const calls = join(dir, 'docker-calls');
    const env = { PATH: dir, V3_PREVIEW_STATE_ROOT: dir };
    const stateFile = writePreviewState({
      version: 1, id, ownerId: randomUUID(), initialized: true,
      names: previewNames(id), secret: randomUUID(), structuralArgs: ['--agent-slice-only'],
    }, env);
    // Stub Docker at the process boundary; never access real containers or a browser.
    writeFileSync(join(dir, 'docker'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
process.stderr.write('No such object'); process.exit(1);
`, { mode: 0o700 });
    const cleanup = ['stop', 'destroy'].includes(action);
    const result = spawnSync(process.execPath, [
      `${root}packages/db/tests/v3/run-workbench.mjs`, '--serve',
      `--preview-id=${id}`, `--preview-action=${action}`,
      ...(action === 'destroy' ? [`--confirm-destroy=${id}`] : []),
    ], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    if (cleanup) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(calls, 'utf8'), /container inspect/);
      assert.equal(existsSync(stateFile), action !== 'destroy');
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(calls), false);
      assert.equal(existsSync(stateFile), true);
    }
    assert.equal(existsSync(join(dir, `${id}.lock`)), false);
  });
}
