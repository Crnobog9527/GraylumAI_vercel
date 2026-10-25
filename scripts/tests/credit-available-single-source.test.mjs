/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// MAINT-P4 (audit A4): the credits a user may spend are computed in one place, credit_available. A spend path that
// adds the holds itself again (as atomic_pre_deduct and bill2_payg_claim each did before 0399) could miss the next
// kind of hold and let it be spent. Reads the generated function files, which CI requires to equal the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const base = resolve(import.meta.dirname, '../../packages/db/functions');
const files = Object.fromEntries(readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory())
  .flatMap(group => readdirSync(resolve(base, group.name)).filter(name => name.endsWith('.sql'))
    .map(name => [`${group.name}/${name}`, readFileSync(resolve(base, group.name, name), 'utf8')])));

// Every hold that credit_available subtracts; a new hold joins this list and credit_available, nowhere else.
const HOLDS = ['credit_package_refund_hold', 'pay_dispute_pending_hold'];
const calls = (text, name) => new RegExp(`\\b${name}\\s*\\(`).test(text.replace(/^-- .*$/gm, ''));

test('credit_available is snapshotted and subtracts every hold', () => {
  const text = files['billing/credit_available.sql'];
  assert.ok(text, 'billing/credit_available.sql is generated (GROUPS in function-snapshots.mjs)');
  for (const hold of [...HOLDS, 'credit_grant_quarantined']) assert.ok(calls(text, hold), hold);
  assert.match(text, /PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED/);
});

test('no other function adds the holds itself', () => {
  for (const hold of HOLDS) {
    const callers = Object.keys(files).filter(path => !path.endsWith(`/${hold}.sql`) && calls(files[path], hold));
    assert.deepEqual(callers, ['billing/credit_available.sql'], `${hold} is only subtracted by credit_available`);
  }
});

test('both spend paths take the available balance from credit_available', () => {
  for (const path of ['billing/atomic_pre_deduct.sql', 'billing/bill2_payg_claim.sql']) {
    assert.ok(calls(files[path], 'credit_available'), path);
    assert.ok(!calls(files[path], 'credit_grant_quarantined'), `${path} does not sum quarantined grants itself`);
  }
});
