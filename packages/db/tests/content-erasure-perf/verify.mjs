/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (process.env.CI || !['--local-only', '--local-only --before-fix', '--local-only --before-0404'].includes(args.join(' '))) {
  throw new Error('Usage: node packages/db/tests/content-erasure-perf/verify.mjs --local-only [--before-fix | --before-0404]');
}
const files = [
  ...(args.includes('--before-fix') ? ['content-erasure-perf/rollback.sql'] : []),
  ...(args.includes('--before-fix') || args.includes('--before-0404') ? ['content-erasure-perf/rollback-confirm.sql'] : []),
  'runtime-view-perf/fixture.sql',
  'content-erasure/fixture.sql',
  'content-erasure-perf/fixture.sql',
  'content-erasure-perf/assertions.sql',
].map(file => `packages/db/tests/${file}`);
const result = spawnSync(process.execPath, [
  'packages/db/tests/run-db-baseline-replay.mjs', '--local-only', '--after', files.join(','),
], {
  cwd: resolve(import.meta.dirname, '../../../..'),
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
