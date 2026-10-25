import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { RATCHET_PATH, checkRatchet, countPatterns, parseRatchet, tightenRatchet } from '../check-pattern-ratchet.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const entry = (over = {}) => ({ id: 'bare-catch', description: 'Use swallow().', include: ['packages/api/src/'],
  regex: '\\.catch\\(\\s*\\(\\)\\s*=>', count: 'matches', max: 2, ...over });

test('counts matches or files, inside include and outside exclude only', () => {
  const sources = new Map([
    ['packages/api/src/a.ts', 'x.catch(() => null); y.catch(()=>false);'],
    ['packages/api/src/b.ts', 'z.catch(() => undefined);'],
    ['packages/api/src/skip.ts', 'z.catch(() => undefined);'],
    ['apps/web/src/c.ts', 'w.catch(() => null);'],
    ['packages/api/src/swallowed.ts', "swallow('x', p, null); p.catch(error => log(error));"],
  ]);
  const ratchet = { patterns: [entry({ exclude: ['packages/api/src/skip.ts'] }), entry({ id: 'files', count: 'files' })] };
  const counts = countPatterns(ratchet, sources);
  assert.equal(counts.get('bare-catch'), 3);
  assert.equal(counts.get('files'), 3);
});

test('fails above the maximum, is stale below it, and --update only lowers', () => {
  const ratchet = { patterns: [entry({ max: 2 })] };
  assert.equal(checkRatchet(ratchet, new Map([['bare-catch', 3]])).errors.length, 1);
  assert.deepEqual(checkRatchet(ratchet, new Map([['bare-catch', 2]])), { errors: [], stale: [] });
  assert.equal(checkRatchet(ratchet, new Map([['bare-catch', 1]])).stale.length, 1);
  assert.equal(tightenRatchet(ratchet, new Map([['bare-catch', 1]])).patterns[0].max, 1);
  assert.equal(tightenRatchet(ratchet, new Map([['bare-catch', 5]])).patterns[0].max, 2);
});

test('rejects malformed entries', () => {
  for (const bad of [entry({ id: 'Bad Id' }), entry({ count: 'lines' }), entry({ max: -1 }), entry({ include: [] }),
    entry({ extra: true }), entry({ regex: '(' }), entry({ description: '' })]) {
    assert.throws(() => parseRatchet(JSON.stringify({ patterns: [bad] })), String(bad.id));
  }
  assert.throws(() => parseRatchet(JSON.stringify({ patterns: [entry(), entry()] })));
});

test('the committed ratchet keeps the five MAINT-P3 patterns and passes on this tree', async () => {
  const ratchet = parseRatchet(await readFile(path.join(repositoryRoot, RATCHET_PATH), 'utf8'));
  assert.deepEqual(ratchet.patterns.map(item => item.id), ['api-bare-catch-fallback', 'system-settings-direct-read',
    'process-env-direct-read', 'web-error-code-includes', 'payments-double-cast']);
  const run = spawnSync(process.execPath, ['scripts/check-pattern-ratchet.mjs'], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('the CI lint job runs the pattern ratchet', async () => {
  const workflow = await readFile(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const start = workflow.indexOf('\n  lint-and-type:');
  const next = workflow.slice(start + 3).search(/\n  [a-z]/);
  const lint = workflow.slice(start, next < 0 ? undefined : start + 3 + next);
  assert.match(lint, /run: node scripts\/check-pattern-ratchet\.mjs/);
});
