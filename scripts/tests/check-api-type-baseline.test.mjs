import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BASELINE_FILE, checkTypeBaseline, runCheck } from '../check-api-type-baseline.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const counts = (entries) => new Map(Object.entries(entries));

test('matching exclusions that all still fail pass', () => {
  const errors = checkTypeBaseline({
    exclude: ['node_modules', 'src/a.test.ts', 'src/b.test.ts'],
    baseline: ['src/a.test.ts', 'src/b.test.ts'],
    errorCounts: counts({ 'src/a.test.ts': 3, 'src/b.test.ts': 1 }),
  });
  assert.deepEqual(errors, []);
});

test('an exclusion outside the baseline fails', () => {
  const errors = checkTypeBaseline({
    exclude: ['node_modules', 'src/a.test.ts', 'src/new.test.ts'],
    baseline: ['src/a.test.ts'],
    errorCounts: counts({ 'src/a.test.ts': 1, 'src/new.test.ts': 2 }),
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /excludes src\/new\.test\.ts, which is not in type-check-baseline\.json/);
  assert.match(errors[1], /src\/new\.test\.ts: 2 type errors outside the baseline/);
});

test('a baselined file that now compiles must be removed', () => {
  const errors = checkTypeBaseline({
    exclude: ['node_modules', 'src/a.test.ts', 'src/fixed.test.ts'],
    baseline: ['src/a.test.ts', 'src/fixed.test.ts'],
    errorCounts: counts({ 'src/a.test.ts': 1 }),
  });
  assert.deepEqual(errors, [
    'src/fixed.test.ts now has no type errors. Remove it from tsconfig.json "exclude" and type-check-baseline.json.',
  ]);
});

test('a baseline entry no longer excluded, or listed twice, fails', () => {
  const errors = checkTypeBaseline({
    exclude: ['node_modules', 'src/a.test.ts'],
    baseline: ['src/a.test.ts', 'src/a.test.ts', 'src/gone.test.ts'],
    errorCounts: counts({ 'src/a.test.ts': 1 }),
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /lists a file more than once/);
  assert.match(errors[1], /lists src\/gone\.test\.ts, which tsconfig\.json no longer excludes/);
});

async function fixture(t, { exclude, baseline }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-type-baseline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(path.join(repositoryRoot, 'packages/api/node_modules'), path.join(directory, 'node_modules'));
  await writeFile(path.join(directory, 'package.json'), '{"name":"fixture","private":true}\n');
  await writeFile(path.join(directory, 'broken.test.ts'), 'export const value: number = "text";\n');
  await writeFile(path.join(directory, 'clean.test.ts'), 'export const value: number = 1;\n');
  await writeFile(
    path.join(directory, 'tsconfig.json'),
    `{\n  // comments are allowed, as in the real tsconfig\n  "compilerOptions": { "strict": true, "noEmit": true, "types": [] },\n  "include": ["*.ts"],\n  "exclude": ${JSON.stringify(exclude)}\n}\n`,
  );
  await writeFile(path.join(directory, BASELINE_FILE), JSON.stringify(baseline));
  return directory;
}

test('a real type-check run accepts a baselined file that still fails', async (t) => {
  const directory = await fixture(t, { exclude: ['node_modules', 'broken.test.ts'], baseline: ['broken.test.ts'] });
  assert.deepEqual(runCheck(directory).errors, []);
});

test('a real type-check run rejects excluding a file that compiles', async (t) => {
  const directory = await fixture(t, {
    exclude: ['node_modules', 'broken.test.ts', 'clean.test.ts'],
    baseline: ['broken.test.ts', 'clean.test.ts'],
  });
  assert.deepEqual(runCheck(directory).errors, [
    'clean.test.ts now has no type errors. Remove it from tsconfig.json "exclude" and type-check-baseline.json.',
  ]);
});

test('a real type-check run rejects an error outside the baseline', async (t) => {
  const directory = await fixture(t, { exclude: ['node_modules'], baseline: [] });
  const { errors } = runCheck(directory);
  assert.deepEqual(errors, ['broken.test.ts: 1 type errors outside the baseline.']);
});
