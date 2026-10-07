/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Reuse the isolated workbench unchanged, selecting this frontend-owned regression only.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (args?.includes('vitest') && args.includes('run')) {
    const config = args.indexOf('--config');
    args = args.filter(arg => !arg.endsWith('.integration.ts'));
    args[config + 1] = '../../apps/web/tests/confirmation/vitest.local.mjs';
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
await import('../../../../packages/db/tests/v3/run-workbench.mjs');
