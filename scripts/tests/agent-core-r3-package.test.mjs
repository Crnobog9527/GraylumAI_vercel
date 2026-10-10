/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, access, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

test('a forged v11 export with matching file bytes/metadata cannot inherit the copied package hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-core-r3-forged-'));
  try {
    const text = 'modified source';
    const source = {manifest: {revisionId: '78c3d0a4-7c9f-4956-ac2d-028cf293f086',
      packageId: '4edbbee8-840b-4322-a01f-c8d49e36e1a8', directoryName: 'social-media-commercial-strategist',
      packageHash: '17e0d061bba369caf295674579cca7b20b7e816723f0edde02ff16e9dfa2cba2',
      tasks: {}, requiredCapabilities: ['documents.read'], files: [{path: 'SKILL.md', bytes: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex'), mediaType: 'text/markdown', requires: []}]},
      files: [{path: 'SKILL.md', base64: Buffer.from(text).toString('base64')}]};
    const input = join(root, 'source.json'), output = join(root, 'release');
    await writeFile(input, JSON.stringify(source));
    const result = spawnSync(process.execPath, [new URL('../agent-core/prepare-r3-package.mjs', import.meta.url).pathname,
      input, output], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Source package hash mismatch/);
    await assert.rejects(access(output));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
