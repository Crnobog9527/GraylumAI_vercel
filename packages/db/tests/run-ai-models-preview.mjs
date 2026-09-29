/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// B01 adapter: reuse the existing local-only workbench in a disposable copy,
// adding this migration and smoke suite without editing another task's runner.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

if (process.argv.slice(2).join(' ') !== '--local-only') throw new Error('Require --local-only');
const root = resolve(import.meta.dirname, '../../..');
const scratch = mkdtempSync(resolve(tmpdir(), 'b01-preview-source-'));
const run = (cmd, args, cwd = root, input) => execFileSync(cmd, args, {
  cwd, input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
});
let child;
const stop = () => { if (child?.pid) child.kill('SIGTERM'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const endpoint = run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).toString().trim();
  if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) throw new Error('Local Docker only');
  console.log('B01 preview candidate:', run('git', ['rev-parse', 'HEAD']).toString().trim());
  run('tar', ['-x', '-C', scratch], root, run('git', ['archive', 'HEAD']));
  const path = resolve(scratch, 'packages/db/tests/v3/run-workbench.mjs');
  let source = readFileSync(path, 'utf8');
  const marker = '  console.log("SQL additive migration and repeat application PASS;';
  const test = '["src/services/__tests__/workbench.integration.ts"]';
  if (source.split(marker).length !== 2 || source.split(test).length !== 2)
    throw new Error('Workbench adapter boundary changed');
  source = source.replace(marker, "  apply('packages/db/migrations/0142_ai_models_column_grants.sql');\n" + marker)
    .replace(test, '["src/services/__tests__/workbench.integration.ts", "src/services/__tests__/modelColumnGrants.integration.ts"]');
  writeFileSync(path, source);
  run('git', ['init', '-q'], scratch);
  run('git', ['add', '.'], scratch);
  run('git', ['-c', 'user.name=Local validation', '-c', 'user.email=local-validation@example.invalid',
    'commit', '-qm', 'Disposable B01 workbench adapter'], scratch);
  child = spawn(process.execPath, [path, '--opc-only', '--with-staging-schema',
    '--case-pattern=^(B01:|OPC: start replay)'],
  { cwd: scratch, stdio: 'inherit' });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code !== 0) process.exitCode = 1;
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  rmSync(scratch, { recursive: true, force: true });
}
