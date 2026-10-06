/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budgetState, openBudget, capNano } from '../cdc-writeback-v2/budget.mjs';

const reserve = (id, nano, stage = 'baseline') => ({ type: 'reserve', id, nano, stage, requestHash: 'a'.repeat(64) });
const settle = (id, nano) => ({ type: 'settle', id, nano });
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'cdc-v2-budget-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('shared cap includes preceding stages; exact cap is allowed', () => {
  const events = [reserve('a', 4e9), settle('a', 4e9), reserve('b', 1e9, 'fields')];
  assert.equal(budgetState(events).pending.nano, 1e9);
  assert.throws(() => budgetState([...events.slice(0, 2), reserve('b', 1e9 + 1, 'prompt')]), /BUDGET_STOP/);
  assert.equal(capNano, 5e9);
});

test('pending, duplicate, invalid amounts, over-settlement, and stop cannot authorize a new call', () => {
  assert.throws(() => budgetState([reserve('a', 100), reserve('b', 1)]), /CALL_ALREADY_RESERVED/);
  assert.throws(() => budgetState([reserve('a', 100), settle('a', 1), reserve('a', 1)]), /CALL_ALREADY_RESERVED/);
  for (const nano of [-1, 0, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => budgetState([reserve('a', nano)]));
  }
  assert.throws(() => budgetState([reserve('a', 100), settle('b', 1)]), /SETTLEMENT_ID/);
  assert.throws(() => budgetState([reserve('a', 100), settle('a', 101)]), /RESERVE_EXCEEDED/);
  assert.throws(() => budgetState([{ type: 'stop', code: 'HTTP' }, reserve('a', 1)]), /JOURNAL_AFTER_STOP/);
});

test('journal survives stages and rejects concurrent writers', t => {
  const dir = temporary(t);
  const first = openBudget(dir);
  assert.throws(() => openBudget(dir), /EEXIST/);
  first.reserve(reserve('a', 100));
  first.settle('a', 0.0000000011);
  assert.equal(first.snapshot().settledNano, 2);
  first.close();
  const second = openBudget(dir);
  assert.equal(second.snapshot().settledNano, 2);
  assert.throws(() => second.reserve(reserve('a', 100)), /CALL_ALREADY_RESERVED/);
  second.reserve(reserve('b', 100, 'suggestions'));
  second.settle('b', 0);
  second.close();
  assert.throws(() => second.reserve(reserve('c', 100)), /BUDGET_CLOSED/);
});

test('unknown cost retains reservation and blocks restart', t => {
  const dir = temporary(t);
  const budget = openBudget(dir);
  budget.reserve(reserve('a', 100));
  assert.throws(() => budget.settle('a', undefined), /COST_UNKNOWN/);
  assert.equal(budget.snapshot().pendingNano, 100);
  budget.close();
  assert.throws(() => openBudget(dir), /BUDGET_PREVIOUS_STOP/);
});

test('truncated journal and permanent failure stop fail closed', t => {
  const dir = temporary(t);
  writeFileSync(join(dir, 'budget.jsonl'), '{');
  assert.throws(() => openBudget(dir), /JOURNAL_TRUNCATED/);
  writeFileSync(join(dir, 'budget.jsonl'), '');
  const budget = openBudget(dir);
  budget.stop('PROVIDER_HTTP_STOP');
  budget.close();
  assert.throws(() => openBudget(dir), /BUDGET_PREVIOUS_STOP/);
});

test('authorized new batch carries old settled and unknown exposure without releasing either', t => {
  const dir = temporary(t), carry = { settledNano: 1_236_088_710, heldNano: 6_337_000, sourceHash: 'b'.repeat(64) };
  const budget = openBudget(dir, carry);
  assert.equal(budget.snapshot().heldNano, carry.heldNano);
  assert.throws(() => budget.reserve(reserve('new/2/a', capNano - carry.settledNano - carry.heldNano + 1)), /BUDGET_STOP/);
  budget.reserve(reserve('new/2/a', 100));
  budget.settle('new/2/a', 0.00000005);
  budget.close();
  assert.throws(() => openBudget(dir), /CARRY_REQUIRED/);
  assert.throws(() => openBudget(dir, { ...carry, heldNano: 0 }), /CARRY_CHANGED/);
  const reopened = openBudget(dir, carry);
  assert.equal(reopened.snapshot().settledNano, carry.settledNano + 50);
  assert.equal(reopened.snapshot().heldNano, carry.heldNano);
  reopened.stop('NETWORK'); reopened.close();
  assert.throws(() => openBudget(dir, carry), /BUDGET_PREVIOUS_STOP/);
});
