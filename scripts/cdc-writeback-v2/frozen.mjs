/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assert, hash, measure } from './source.mjs';
import { budgetState, openBudget } from './budget.mjs';

export const pin = Object.freeze({
  manifestHash: '48f647dc033063b2933bb232ad1f019fb533e2daf25d7e48a1d528adfe517818',
  oldLedgerHash: 'df1c877d31897833398166c36edfb80ab55a44cffda3211e8f4d1c7a55ce165b',
  casesHash: '8258d5753b4a8626a26234246c37e9e3a9cd3c94f24bf86ea4c96b7303b6f76f',
  specialHash: '9c29090a99ff60584c7265f5bfc5eceff7e71d9be334bcbe2527422d9e822c7e',
  settledNano: 1_283_921_128, heldNano: 6_337_000, newReserveNano: 1_639_811_000, count: 224,
});
export const batches = ['A100', 'B100', 'A12', 'B12'];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = path => hash(readFileSync(path));
const integer = n => Number.isSafeInteger(n) && n >= 0;

// The injected pin is for synthetic tests; the CLI always uses the constant above.
export function loadFrozen(directory, ledgerPath, expected = pin, casesPath = join(dirname(dirname(ledgerPath)), 'cases.json')) {
  assert(digest(join(directory, 'requests.manifest.json')) === expected.manifestHash, 'MANIFEST_CHANGED');
  assert(digest(join(directory, 'special12.json')) === expected.specialHash, 'SPECIAL_CHANGED');
  assert(digest(casesPath) === expected.casesHash, 'CASES_CHANGED');
  const rawLedger = readFileSync(ledgerPath, 'utf8');
  assert(hash(rawLedger) === expected.oldLedgerHash && rawLedger.endsWith('\n'), 'OLD_LEDGER_CHANGED');
  const old = budgetState(rawLedger.trimEnd().split('\n').map(JSON.parse));
  assert(!old.pending && !old.stopped && old.settledNano === expected.settledNano &&
    old.heldNano === expected.heldNano, 'OLD_EXPOSURE_CHANGED');
  const rows = json(join(directory, 'requests.manifest.json'));
  assert(rows.length === expected.count && new Set(rows.map(r => r.id)).size === expected.count, 'ROSTER_COUNT');
  let sum = 0;
  const requests = rows.map(row => {
    assert(/^[AB]\/(C\d{3}|P\d{2})$/.test(row.id) && row.id === `${row.stage}/${row.slot}`, 'ROSTER_ID');
    assert(row.group === (row.slot.startsWith('C') ? 'original100' : 'source12'), 'ROSTER_GROUP');
    const raw = readFileSync(join(directory, row.id.replace('/', '-') + '.request.json'), 'utf8');
    const measured = measure(raw, 'organizer');
    assert(measured.requestHash === row.requestHash && measured.reserveNano === row.reserveNano &&
      Buffer.byteLength(raw) === row.bytes, 'REQUEST_CHANGED');
    const body = JSON.parse(raw);
    assert(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(
      ['max_tokens', 'messages', 'model', 'provider', 'store', 'stream']), 'EXTRA_REQUEST_PARAMETER');
    assert(body.messages.length === 2 && body.messages[0].role === 'system' &&
      body.messages[1].role === 'user' && body.messages.every(m => typeof m.content === 'string'), 'MESSAGES');
    sum += row.reserveNano;
    return { ...row, raw, batch: row.stage + (row.group === 'original100' ? '100' : '12') };
  });
  assert(integer(sum) && sum === expected.newReserveNano &&
    sum + old.settledNano + old.heldNano <= 5_000_000_000, 'FROZEN_BUDGET');
  return { requests, expected, directory, ledgerPath, casesPath,
    carry: { settledNano: old.settledNano, heldNano: old.heldNano, sourceHash: expected.oldLedgerHash } };
}

function durable(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    const data = Buffer.from(JSON.stringify(value) + '\n');
    let offset = 0;
    while (offset < data.length) {
      const n = writeSync(fd, data, offset, data.length - offset);
      assert(n > 0, 'EVIDENCE_WRITE_FAILED'); offset += n;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function validateResponse(response) {
  assert(response.status === 200, 'HTTP_STOP');
  const body = JSON.parse(response.body);
  assert(body.provider === 'OpenAI' && body.choices?.length === 1 &&
    body.choices[0].finish_reason === 'stop', 'ROUTE_FINISH_STOP');
  const output = JSON.parse(body.choices[0].message.content);
  assert(['answer', 'acknowledgement', 'uncertainty', 'request', 'revision_request'].includes(output.inputKind) &&
    Array.isArray(output.patches) && output.patches.length <= 12 &&
    Array.isArray(output.notes) && output.notes.length === 0, 'FORMAT_STOP');
  for (const p of output.patches) {
    assert(typeof p.stepId === 'string' && typeof p.fieldId === 'string' && typeof p.value === 'string' &&
      p.value.length <= 400 && ['provisional', 'unclear'].includes(p.status) &&
      ['fact', 'decision', 'hypothesis', 'unknown'].includes(p.nature) &&
      ['user_statement', 'agent_proposal'].includes(p.basis), 'PATCH_FORMAT_STOP');
  }
  return body.usage?.cost;
}

export function validateApproval(approval, frozen, executionHead) {
  assert(approval?.authorized === true && approval.manifestHash === frozen.expected.manifestHash &&
    approval.executionHead === executionHead && /^[a-f0-9]{40}$/.test(executionHead) &&
    /^https:\/\/github\.com\/Crnobog9527\/GraylumAI_vercel\/(issues|pull)\/\d+#issuecomment-\d+$/.test(approval.evidenceUrl) &&
    approval.newReserveNano === frozen.expected.newReserveNano && approval.count === frozen.expected.count &&
    approval.totalCapNano === 5_000_000_000 && approval.unknownHeldNano === frozen.expected.heldNano,
  'EXPLICIT_APPROVAL_REQUIRED');
}

function priorBatch(output, previous) {
  const completed = json(join(output, `${previous}.completed.json`));
  const lock = json(join(output, `${previous}.score-lock.json`));
  const scores = readFileSync(join(output, `${previous}.scores.json`));
  assert(lock.responsesHash === completed.responsesHash && lock.scoresHash === hash(scores), 'SCORES_NOT_LOCKED');
  const responses = completed.ids.map(id => {
    const raw = readFileSync(join(output, id.replace('/', '-') + '.response.json'));
    return hash(raw);
  });
  assert(hash(JSON.stringify(responses)) === completed.responsesHash, 'PREVIOUS_RESPONSES_CHANGED');
  const entries = JSON.parse(scores);
  assert(Array.isArray(entries) && JSON.stringify(entries.map(r => r.id).sort()) ===
    JSON.stringify([...completed.ids].sort()) && entries.every(r => typeof r.pass === 'boolean'), 'SCORE_ROSTER');
}

// No network/credential access here. CLI supplies the adapter only after approval.
// A later frozen roster may declare its own batch order and response validator; defaults keep the V2 roster.
export async function executeBatch(frozen, batch, approval, executionHead, { preflight, send, validate = validateResponse }) {
  validateApproval(approval, frozen, executionHead);
  const order = frozen.batches ?? batches;
  assert(order.includes(batch), 'BATCH');
  const output = join(frozen.directory, 'execution');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const budget = openBudget(output, frozen.carry);
  try {
    const started = join(output, `${batch}.started.json`);
    assert(!existsSync(started), 'NO_RETRY');
    const index = order.indexOf(batch);
    if (index > 0) priorBatch(output, order[index - 1]);
    durable(started, { executionHead, approval, batch });
    await preflight();
    const selected = frozen.requests.filter(r => r.batch === batch);
    assert(selected.length > 0, 'BATCH_EMPTY');
    // Reserve the full frozen batch allowance, regardless of cheaper earlier results.
    const allStarted = order.filter(b => existsSync(join(output, `${b}.started.json`)));
    const reservedTotal = frozen.requests.filter(r => allStarted.includes(r.batch)).reduce((sum, r) => sum + r.reserveNano, 0);
    assert(reservedTotal <= approval.newReserveNano, 'NEW_BUDGET_STOP');
    const responseHashes = [];
    const checkGold = () => {
      assert(digest(join(frozen.directory, 'special12.json')) === frozen.expected.specialHash, 'SPECIAL_CHANGED');
      assert(digest(frozen.casesPath) === frozen.expected.casesHash, 'CASES_CHANGED');
    };
    for (const row of selected) {
      checkGold();
      assert(digest(frozen.ledgerPath) === frozen.expected.oldLedgerHash, 'OLD_LEDGER_CHANGED');
      assert(digest(join(frozen.directory, 'requests.manifest.json')) === frozen.expected.manifestHash &&
        digest(join(frozen.directory, row.id.replace('/', '-') + '.request.json')) === row.requestHash, 'REQUEST_CHANGED');
      budget.reserve({ id: row.id, stage: row.budgetStage ?? (row.stage === 'A' ? 'fields' : 'prompt'),
        requestHash: row.requestHash, nano: row.reserveNano });
      const response = await send(row.raw);
      const responsePath = join(output, row.id.replace('/', '-') + '.response.json');
      durable(responsePath, { id: row.id, requestHash: row.requestHash, ...response });
      // Unknown/invalid results retain the pending reserve, including across restarts.
      const cost = validate(response);
      budget.settle(row.id, cost);
      responseHashes.push(digest(responsePath));
    }
    checkGold();
    durable(join(output, `${batch}.completed.json`), { ids: selected.map(r => r.id),
      responsesHash: hash(JSON.stringify(responseHashes)), ...budget.snapshot() });
    return { completed: selected.length, ...budget.snapshot() };
  } catch (error) {
    budget.stop('FROZEN_BATCH_STOP');
    throw error;
  } finally { budget.close(); }
}
