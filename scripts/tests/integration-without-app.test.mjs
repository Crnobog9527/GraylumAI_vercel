import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWithoutAppResults, withoutAppPattern, WITHOUT_APP_SUITES } from '../../packages/db/tests/v3/without-app.mjs';

const runtime = WITHOUT_APP_SUITES.runtime;
const excludedNames = [
  runtime.excluded[0].name,
  'RUNTIME: attached organizer search=false stopAfterPrimary=false preserves original run',
  'RUNTIME: attached organizer search=true stopAfterPrimary=false preserves original run',
  'RUNTIME: attached organizer search=false stopAfterPrimary=true preserves original run',
  runtime.excluded[2].name,
];
const file = (name, assertionResults, status = 'passed') => ({ name: '/tmp/copy/packages/api/' + name, status, assertionResults });
const pass = (fullName) => ({ fullName, status: 'passed' });
const skip = (fullName) => ({ fullName, status: 'skipped' });
const runtimeReport = (extra = [], failed = 0) => ({
  numFailedTests: failed,
  testResults: [
    file(runtime.files[0], [pass('RUNTIME: atomic draft/session/start replay'), ...excludedNames.map(skip), ...extra]),
    file(runtime.files[1], [pass('RUNTIME: streaming saved receipt replays')]),
    file(runtime.files[2], [pass('RUNTIME: terminal paid reply cancels once')]),
    file(runtime.files[3], [pass('RUNTIME: H1 frozen history replays')]),
    file(runtime.files[4], [pass('RUNTIME: capture batch counts')]),
    file(runtime.files[5], [pass('RUNTIME: R13 capture and confirmation')]),
    file(runtime.files[6], [pass('RUNTIME: v2 R13 financial conservation')]),
  ],
});

test('name patterns select the suite prefix and exclude exactly the app-only cases', () => {
  const bill2 = new RegExp(withoutAppPattern('bill2'));
  assert.ok(bill2.test('BILL2: prepares both persisted scope kinds'));
  assert.ok(!bill2.test('AI: workbench'));
  const pattern = new RegExp(withoutAppPattern('runtime'));
  assert.ok(pattern.test('RUNTIME: atomic draft/session/start replay, admission and SDK append identities'));
  assert.ok(pattern.test('RUNTIME: streaming saved receipt replays through SDK after completion failure'));
  for (const name of excludedNames) assert.ok(!pattern.test(name), name);
  assert.ok(!pattern.test('OPC: anything'));
});

test('verification passes only when every non-excluded case passed', () => {
  const result = verifyWithoutAppResults('runtime', runtimeReport());
  assert.deepEqual(result.errors, []);
  assert.equal(result.passed, 7);
  assert.equal(result.skipped, 5);
});

test('verification fails closed on failures, unlisted skips, missing files and stale exclusions', () => {
  assert.ok(verifyWithoutAppResults('runtime', runtimeReport([], 1)).errors.length);
  assert.ok(verifyWithoutAppResults('runtime', runtimeReport([skip('RUNTIME: staging window runs')])).errors.length);
  assert.ok(verifyWithoutAppResults('runtime', runtimeReport([{ fullName: 'RUNTIME: x', status: 'failed' }])).errors.length);
  const missingFile = runtimeReport();
  missingFile.testResults.pop();
  assert.ok(verifyWithoutAppResults('runtime', missingFile).errors.some((error) => error.includes('no passing case')));
  const stale = runtimeReport();
  stale.testResults[0].assertionResults = stale.testResults[0].assertionResults.filter((test) => !test.fullName.includes('organizer'));
  assert.ok(verifyWithoutAppResults('runtime', stale).errors.some((error) => error.includes('expected 3')));
  const unexpected = runtimeReport();
  unexpected.testResults.push(file('src/services/__tests__/workbench.integration.ts', []));
  assert.ok(verifyWithoutAppResults('runtime', unexpected).errors.some((error) => error.includes('unexpected test file')));
  assert.ok(verifyWithoutAppResults('bill2', { numFailedTests: 0, testResults: [] }).errors.length);
  const bill2Skip = { numFailedTests: 0, testResults: [file(WITHOUT_APP_SUITES.bill2.files[0], [pass('BILL2: a'), skip('BILL2: b')])] };
  assert.ok(verifyWithoutAppResults('bill2', bill2Skip).errors.length);
});
