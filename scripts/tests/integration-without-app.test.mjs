import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWithoutAppResults, withoutAppPattern, WITHOUT_APP_SUITES } from '../../packages/db/tests/v3/without-app.mjs';

const runtime = WITHOUT_APP_SUITES.runtime;
const file = (name, assertionResults, status = 'passed') => ({ name: '/tmp/copy/packages/api/' + name, status, assertionResults });
const pass = (fullName) => ({ fullName, status: 'passed' });
const skip = (fullName) => ({ fullName, status: 'skipped' });
const runtimeReport = (extra = [], failed = 0) => ({
  numFailedTests: failed,
  testResults: [
    file(runtime.files[0], [pass('RUNTIME: CORE-PATH-V2 V2-4a: a free-chat turn opens, streams, calls once in three writes, settles once'), ...extra]),
    file(runtime.files[1], [pass('RUNTIME: CORE-PATH-V2 V2-5: a mentor turn opens with the draft, reads one Skill file, applies the organizer patch')]),
    file(runtime.files[2], [pass('RUNTIME: CORE-PATH-V2 V2-7b: a compare answers in parallel columns')]),
    file(runtime.files[3], [pass('RUNTIME: CORE-PATH-V2 V2-6: a free chat searches once: one tool row, the continuation in three writes')]),
  ],
});

test('name patterns select the suite prefix', () => {
  const pattern = new RegExp(withoutAppPattern('runtime'));
  assert.ok(pattern.test('RUNTIME: CORE-PATH-V2 V2-4a: a free-chat turn opens'));
  assert.ok(!pattern.test('OPC: anything'));
});

test('verification passes only when every case passed', () => {
  const result = verifyWithoutAppResults('runtime', runtimeReport());
  assert.deepEqual(result.errors, []);
  assert.equal(result.passed, runtime.files.length);
  assert.equal(result.skipped, 0);
});

test('verification fails closed on failures, unlisted skips, missing files and unexpected files', () => {
  assert.ok(verifyWithoutAppResults('runtime', runtimeReport([], 1)).errors.length);
  assert.ok(verifyWithoutAppResults('runtime', runtimeReport([skip('RUNTIME: staging window runs')])).errors.length);
  assert.ok(verifyWithoutAppResults('runtime', runtimeReport([{ fullName: 'RUNTIME: x', status: 'failed' }])).errors.length);
  const missingFile = runtimeReport();
  missingFile.testResults.pop();
  assert.ok(verifyWithoutAppResults('runtime', missingFile).errors.some((error) => error.includes('no passing case')));
  const unexpected = runtimeReport();
  unexpected.testResults.push(file('src/services/__tests__/workbench.integration.ts', []));
  assert.ok(verifyWithoutAppResults('runtime', unexpected).errors.some((error) => error.includes('unexpected test file')));
});
