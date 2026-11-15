/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local file install only. Run from the reviewed, merged checkout; no database/platform calls.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [flag, destination, ...extra] = process.argv.slice(2);
if (flag !== '--target' || !destination || extra.length) throw new Error('Usage: --target <local controller-tools directory>');
const target = resolve(destination.replace(/^~(?=\/|$)/, homedir()));
const files = ['scripts/controller-review.mjs', 'scripts/staging-structure.mjs', 'packages/db/tests/baseline/staging-comparison.mjs',
  'packages/db/tests/baseline/staging-test-permissions.json', 'packages/db/tests/baseline/expected-differences.json',
  'packages/db/tests/baseline/fingerprint.sql'];
const backup = resolve(target, `structure-backup-${Date.now()}`);
const installed = {};
for (const [source, dest] of [...files.map(file => [file, `structure-check/${file}`]),
  ...['mig-go.sh', 'mig-apply.sh'].map(file => [`scripts/controller-tools/${file}`, file])]) {
  const path = resolve(target, dest);
  if (existsSync(path)) {
    const old = resolve(backup, dest);
    mkdirSync(dirname(old), { recursive: true });
    copyFileSync(path, old);
  }
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(resolve(root, source), path);
  installed[dest] = createHash('sha256').update(readFileSync(path)).digest('hex');
}
writeFileSync(resolve(target, 'structure-check/install-sha256.json'), `${JSON.stringify(installed, null, 2)}\n`);
console.log('Installed exact staging structure tools; previous files backed up locally.');
