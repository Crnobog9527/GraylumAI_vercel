/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Offline schema validation only; never reads credentials or writes settings.
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
const require = createRequire(new URL('../packages/api/package.json', import.meta.url));
const viteRequire = createRequire(require.resolve('vite'));
const {build} = require(viteRequire.resolve('esbuild'));
const directory = await mkdtemp(join(tmpdir(), 'graylum-profile-validation-'));
try {
  const modulePath = join(directory, 'schema.cjs');
  await build({entryPoints: [resolve('packages/api/src/services/runtime/paygHostPolicy.ts')],
    outfile: modulePath, bundle: true, platform: 'node', format: 'cjs'});
  const {paygHostSettings} = require(modulePath);
  const file = process.argv[2] ?? 'docs/launch/evidence/payg-profile-final.json';
  const value = paygHostSettings.parse(JSON.parse(await readFile(file, 'utf8')));
  console.log(JSON.stringify({schema: 'PASS', profiles: value.profiles.length,
    windowIdPlaceholder: value.windowId === '00000000-0000-0000-0000-000000000000'}));
} finally {
  await rm(directory, {recursive: true, force: true});
}
