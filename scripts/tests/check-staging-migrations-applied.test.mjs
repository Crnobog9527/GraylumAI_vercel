import assert from 'node:assert/strict';
import test from 'node:test';
import { compareApplied, parseSnapshot } from '../check-staging-migrations-applied.mjs';

const files = [
  '0001_ai_billing_tables.sql',
  '0047_subscription_grants.sql',
  '0164_provider_rejection.sql',
  '0340_old_style.sql',
  '0346_prices_swap.sql',
  '0350_after_gap.sql',
];
const rows = [
  { version: '0047', name: 'subscription_grants' },
  { version: '20261004145249', name: 'provider_rejection' },
  { version: '0340', name: 'old_style' },
  { version: '20261024180259', name: '0346_prices_swap' },
  { version: '20261025000000', name: '0350_after_gap' },
];

test('passes when every recorded migration matches a file, gaps included', () => {
  assert.deepEqual(compareApplied(rows, files), []);
});

test('reports a merged migration that staging never applied', () => {
  const errors = compareApplied(rows.slice(0, -1), files);
  assert.deepEqual(errors, ['仓库有迁移、staging 没有应用记录：0350_after_gap.sql']);
});

test('reports an applied record with no repository file', () => {
  const errors = compareApplied([...rows, { version: '20261025010101', name: '0351_not_merged' }], files);
  assert.deepEqual(errors, ['staging 有应用记录、仓库里找不到对应文件：version 20261025010101 name 0351_not_merged']);
});

test('accepts a migration recorded twice (historical re-applies)', () => {
  assert.deepEqual(compareApplied([...rows, { version: '20261025020202', name: '0346_prices_swap' }], files), []);
});

test('tolerates the known pre-ledger history and rehearsal records only', () => {
  const extra = [
    { version: '20261014052653', name: '0256_fusion_review_flow_early_16d5f377' },
    { version: '20261008081743', name: 'erasure_executor_probe_success_20261008' },
  ];
  assert.deepEqual(compareApplied([...rows, ...extra], files), []);
  const errors = compareApplied(rows, [...files, '0044_unrecorded.sql']);
  assert.deepEqual(errors, ['仓库有迁移、staging 没有应用记录：0044_unrecorded.sql']);
});

test('reports a malformed migration filename', () => {
  assert.deepEqual(compareApplied(rows, [...files, '351_bad.sql']), ['迁移文件名格式不对：351_bad.sql']);
});

test('parses supabase CLI JSON output with surrounding text', () => {
  const text = 'Connecting...\n{"boundary":"x","rows":[{"version":"0047","name":"a"}],"warning":"w"}\n';
  assert.deepEqual(parseSnapshot(text), [{ version: '0047', name: 'a' }]);
  assert.deepEqual(parseSnapshot('[{"version":1,"name":"b"}]'), [{ version: '1', name: 'b' }]);
});
