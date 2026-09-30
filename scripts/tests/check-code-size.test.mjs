import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_LINE_LENGTH,
  MAX_LINES,
  checkCodeSize,
  isCheckedFile,
  measure,
  parseBaseline,
  tightenBaseline,
} from '../check-code-size.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const long = 'x'.repeat(MAX_LINE_LENGTH + 1);
const lines = count => Array.from({ length: count }, (_, index) => `const v${index} = ${index};`).join('\n') + '\n';

test('measures lines and overlong lines in code points', () => {
  assert.deepEqual(measure('a\nb\n'), { lines: 2, longLines: 0 });
  assert.deepEqual(measure('a\nb'), { lines: 2, longLines: 0 });
  assert.deepEqual(measure(''), { lines: 0, longLines: 0 });
  assert.deepEqual(measure(`${'中'.repeat(MAX_LINE_LENGTH)}\r\n${long}\n`), { lines: 2, longLines: 1 });
});

test('checks production source files only', () => {
  for (const file of ['apps/web/src/app/page.tsx', 'packages/api/src/trpc.ts', 'scripts/check-migration-ledger.mjs']) assert.ok(isCheckedFile(file), file);
  for (const file of [
    'packages/api/src/routers/ai.test.ts',
    'packages/api/src/services/runtime/runtime.integration.ts',
    'packages/api/src/services/__tests__/stripe.test.ts',
    'apps/web/e2e/security.spec.ts',
    'packages/db/tests/v3/run-workbench.mjs',
    'packages/db/migrations/0001_init.sql',
    'docs/ENGINEERING.md',
  ]) assert.ok(!isCheckedFile(file), file);
});

test('new files must respect the limits and baselined files may not grow', () => {
  const measurements = new Map([
    ['new.ts', { lines: MAX_LINES + 1, longLines: 1 }],
    ['old.ts', { lines: 900, longLines: 3 }],
  ]);
  const { errors } = checkCodeSize(measurements, { 'old.ts': { lines: 899, longLines: 3 } });
  assert.equal(errors.length, 3);
  assert.match(errors.join('\n'), /new\.ts: 501 lines, allowed 500/);
  assert.match(errors.join('\n'), /new\.ts: 1 lines longer than 160 characters, allowed 0/);
  assert.match(errors.join('\n'), /old\.ts: 900 lines, allowed 899/);
});

test('an exact baseline passes and every improvement must be recorded', () => {
  const baseline = { 'old.ts': { lines: 900, longLines: 3 }, 'gone.ts': { lines: 700 } };
  assert.deepEqual(checkCodeSize(new Map([['old.ts', { lines: 900, longLines: 3 }]]), { 'old.ts': baseline['old.ts'] }), {
    errors: [],
    stale: [],
  });
  const { errors, stale } = checkCodeSize(new Map([['old.ts', { lines: 400, longLines: 2 }]]), baseline);
  assert.deepEqual(errors, []);
  assert.deepEqual(stale, [
    'old.ts: baseline lines=900, longLines=3 can be lowered to longLines=2.',
    'gone.ts: baseline lines=700 is no longer needed.',
  ]);
});

test('tightening lowers or removes entries and never raises them', () => {
  const measurements = new Map([
    ['grew.ts', { lines: 950, longLines: 9 }],
    ['shrank.ts', { lines: 600, longLines: 0 }],
    ['fixed.ts', { lines: 100, longLines: 0 }],
    ['new.ts', { lines: 800, longLines: 4 }],
  ]);
  const baseline = { 'grew.ts': { lines: 900, longLines: 5 }, 'shrank.ts': { lines: 700, longLines: 2 }, 'fixed.ts': { lines: 510 } };
  assert.deepEqual(tightenBaseline(measurements, baseline), { 'grew.ts': { lines: 900, longLines: 5 }, 'shrank.ts': { lines: 600 } });
});

test('rejects malformed baseline entries', () => {
  assert.deepEqual(parseBaseline('{"a.ts":{"lines":600}}'), { 'a.ts': { lines: 600 } });
  for (const text of ['[]', '{"a.ts":{}}', '{"a.ts":{"lines":0}}', '{"a.ts":{"lines":1.5}}', '{"a.ts":{"width":9}}']) {
    assert.throws(() => parseBaseline(text), /baseline/, text);
  }
});

test('the command enforces the ratchet in a git checkout and --update never raises', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'graylum-code-size-'));
  try {
    await mkdir(path.join(directory, 'scripts'), { recursive: true });
    await copyFile(path.join(repositoryRoot, 'scripts/check-code-size.mjs'), path.join(directory, 'scripts/check-code-size.mjs'));
    const baselineFile = path.join(directory, 'scripts/code-size-baseline.json');
    await writeFile(baselineFile, '{\n  "big.ts": {"lines":600}\n}\n');
    await writeFile(path.join(directory, 'big.ts'), lines(600));
    await writeFile(path.join(directory, 'big.test.ts'), lines(2000));
    execFileSync('git', ['init', '--quiet'], { cwd: directory });
    execFileSync('git', ['add', '.'], { cwd: directory });
    const run = (...args) => spawnSync(process.execPath, ['scripts/check-code-size.mjs', ...args], { cwd: directory, encoding: 'utf8' });

    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed for 2 source files/);

    await writeFile(path.join(directory, 'big.ts'), lines(601));
    result = run('--update');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /big\.ts: 601 lines, allowed 600/);
    assert.equal(await readFile(baselineFile, 'utf8'), '{\n  "big.ts": {"lines":600}\n}\n');

    await writeFile(path.join(directory, 'big.ts'), lines(550));
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /can be lowered to lines=550/);
    result = run('--update');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(baselineFile, 'utf8'), '{\n  "big.ts": {"lines":550}\n}\n');

    await writeFile(path.join(directory, 'big.ts'), lines(20));
    assert.equal(run('--update').status, 0);
    assert.equal(await readFile(baselineFile, 'utf8'), '{}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
