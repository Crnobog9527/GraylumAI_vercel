import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWithoutAppResults, withoutAppPattern, WITHOUT_APP_SUITES } from '../../packages/db/tests/v3/without-app.mjs';

const runtime = WITHOUT_APP_SUITES.runtime;
// The turn-path suites have no case that needs the local application or a browser, so the list is empty today. A case
// that does need one must be added to `excluded` with its reason; these tests keep that mechanism working while empty by
// adding a temporary entry for the duration of one assertion.
const EXCLUDED = {
  name: 'RUNTIME: browser case that needs the local application',
  cases: 2,
  reason: 'launches a desktop Chrome and drives the local Next application',
};
const withExclusion = (fn) => {
  runtime.excluded.push(EXCLUDED);
  try { return fn(); } finally { runtime.excluded.pop(); }
};
const skippedExclusion = () => [
  { fullName: EXCLUDED.name + ' one', status: 'skipped' },
  { fullName: EXCLUDED.name + ' two', status: 'skipped' },
];
const file = (name, assertionResults, status = 'passed') => ({ name: '/tmp/copy/packages/api/' + name, status, assertionResults });
const pass = (fullName) => ({ fullName, status: 'passed' });
const skip = (fullName) => ({ fullName, status: 'skipped' });
const caseNames = [
  'RUNTIME: CORE-PATH-V2 V2-4a: a free-chat turn opens, streams, calls once in three writes, settles once',
  'RUNTIME: CORE-PATH-V2 V2-5: a mentor turn opens with the draft, reads one Skill file, applies the organizer patch',
  'RUNTIME: CORE-PATH-V2 V2-7b: a compare answers in parallel columns',
  'RUNTIME: CORE-PATH-V2 V2-6: a free chat searches once: one tool row, the continuation in three writes',
];
const runtimeReport = (extra = [], failed = 0) => ({
  numFailedTests: failed,
  testResults: runtime.files.map((name, index) =>
    file(name, [pass(caseNames[index] ?? 'RUNTIME: case ' + index), ...(index === 0 ? extra : [])])),
});

test('the suite lists only turn-path files and every exclusion states its reason', () => {
  assert.ok(runtime.files.length > 0);
  assert.ok(runtime.files.every((name) => name.startsWith('src/services/turn/')));
  for (const [suite, { prefix, excluded }] of Object.entries(WITHOUT_APP_SUITES)) {
    for (const entry of excluded) {
      assert.ok(entry.name.startsWith(prefix), `${suite}: ${entry.name} must start with ${prefix}`);
      assert.ok(Number.isInteger(entry.cases) && entry.cases > 0, `${suite}: ${entry.name} needs a case count`);
      assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length > 0, `${suite}: ${entry.name} needs a reason`);
    }
  }
  assert.ok(EXCLUDED.reason.trim().length > 0);
});

test('name patterns select the suite prefix and exclude exactly the app-only cases', () => {
  const plain = new RegExp(withoutAppPattern('runtime'));
  assert.ok(plain.test('RUNTIME: CORE-PATH-V2 V2-4a: a free-chat turn opens'));
  assert.ok(plain.test(EXCLUDED.name));
  assert.ok(!plain.test('OPC: anything'));
  withExclusion(() => {
    const pattern = new RegExp(withoutAppPattern('runtime'));
    assert.ok(pattern.test('RUNTIME: CORE-PATH-V2 V2-4a: a free-chat turn opens'));
    assert.ok(!pattern.test(EXCLUDED.name + ' one'));
    assert.ok(!pattern.test('OPC: anything'));
  });
});

test('verification passes only when every non-excluded case passed', () => {
  const result = verifyWithoutAppResults('runtime', runtimeReport());
  assert.deepEqual(result.errors, []);
  assert.equal(result.passed, runtime.files.length);
  assert.equal(result.skipped, 0);
  withExclusion(() => {
    const listed = verifyWithoutAppResults('runtime', runtimeReport(skippedExclusion()));
    assert.deepEqual(listed.errors, []);
    assert.equal(listed.skipped, 2);
  });
});

test('verification fails closed on failures, unlisted skips, missing files and stale exclusions', () => {
  assert.ok(verifyWithoutAppResults('runtime', runtimeReport([], 1)).errors.length);
  assert.ok(verifyWithoutAppResults('runtime', runtimeReport([skip('RUNTIME: staging window runs')])).errors.length);
  // With no exclusion listed, even the otherwise allowed app-only case is an unexpected skip.
  assert.ok(verifyWithoutAppResults('runtime', runtimeReport(skippedExclusion())).errors.length);
  assert.ok(verifyWithoutAppResults('runtime', runtimeReport([{ fullName: 'RUNTIME: x', status: 'failed' }])).errors.length);
  const missingFile = runtimeReport();
  missingFile.testResults.pop();
  assert.ok(verifyWithoutAppResults('runtime', missingFile).errors.some((error) => error.includes('no passing case')));
  withExclusion(() => {
    const stale = runtimeReport();
    assert.ok(verifyWithoutAppResults('runtime', stale).errors.some((error) => error.includes('expected 2')));
  });
  const unexpected = runtimeReport();
  unexpected.testResults.push(file('src/services/__tests__/workbench.integration.ts', []));
  assert.ok(verifyWithoutAppResults('runtime', unexpected).errors.some((error) => error.includes('unexpected test file')));
});
