/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import strict from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFrozen, executeBatch, validateResponse, batches } from '../cdc-writeback-v2/frozen.mjs';
import { hash, measure } from '../cdc-writeback-v2/source.mjs';
import { budgetState } from '../cdc-writeback-v2/budget.mjs';
const head = 'a'.repeat(40);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cdc-frozen-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data) + '\n');
  const raw = JSON.stringify({ model: 'openai/gpt-6-luna', messages: [
    { role: 'system', content: 'synthetic' }, { role: 'user', content: 'synthetic' }],
  max_tokens: 2048, stream: false, store: false, provider: { allow_fallbacks: false, require_parameters: true,
    only: ['openai'], max_price: { prompt: 0.25, completion: 0.75, request: 0 } } });
  const rows = ['A/C001', 'B/C001', 'A/P01', 'B/P01'].map(id => ({ id, stage: id[0], slot: id.slice(2),
    group: id[2] === 'C' ? 'original100' : 'source12', bytes: Buffer.byteLength(raw), ...measure(raw, 'organizer') }));
  for (const row of rows) writeFileSync(join(dir, row.id.replace('/', '-') + '.request.json'), raw);
  write('requests.manifest.json', rows); write('special12.json', []);
  write('old.jsonl', { type: 'carry', settledNano: 1_283_921_128, heldNano: 6_337_000, sourceHash: 'c'.repeat(64) });
  const ledger = join(dir, 'old.jsonl');
  const expected = { manifestHash: hash(readFileSync(join(dir, 'requests.manifest.json'))),
    specialHash: hash(readFileSync(join(dir, 'special12.json'))), oldLedgerHash: hash(readFileSync(ledger)),
    count: 4, newReserveNano: rows.reduce((s, r) => s + r.reserveNano, 0), settledNano: 1_283_921_128, heldNano: 6_337_000 };
  const frozen = loadFrozen(dir, ledger, expected);
  const approval = { authorized: true, manifestHash: expected.manifestHash, executionHead: head,
    evidenceUrl: 'https://github.com/Crnobog9527/GraylumAI_vercel/issues/716#issuecomment-123',
    newReserveNano: expected.newReserveNano, count: 4, totalCapNano: 5e9, unknownHeldNano: 6337000 };
  const state = () => budgetState(readFileSync(join(dir, 'execution/budget.jsonl'), 'utf8').trim().split('\n').map(JSON.parse));
  return { dir, write, rows, ledger, expected, frozen, approval, state };
}
const good = () => ({ status: 200, body: JSON.stringify({ provider: 'OpenAI', usage: { cost: 0.000001 },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }) } }] }) });
function lock(f, batch) {
  const done = JSON.parse(readFileSync(join(f.dir, `execution/${batch}.completed.json`)));
  f.write(`execution/${batch}.scores.json`, done.ids.map(id => ({ id, pass: true })));
  f.write(`execution/${batch}.score-lock.json`, { responsesHash: done.responsesHash,
    scoresHash: hash(readFileSync(join(f.dir, `execution/${batch}.scores.json`))) });
}

test('unapproved, stale code, raised budget or released unknown cannot reach preflight', async t => {
  const f = fixture(t); let calls = 0;
  const adapter = { preflight: async () => { calls++; }, send: async () => { calls++; return good(); } };
  for (const patch of [{ authorized: false }, { executionHead: 'b'.repeat(40) }, { totalCapNano: 6e9 },
    { newReserveNano: f.approval.newReserveNano + 1 }, { unknownHeldNano: 0 }, { count: 5 }]) {
    await strict.rejects(executeBatch(f.frozen, 'A100', { ...f.approval, ...patch }, head, adapter), /APPROVAL/);
  }
  strict.equal(calls, 0); strict.equal(existsSync(join(f.dir, 'execution')), false);
});

test('all four stages preserve old exposure; scores lock each preceding stage; no retry', async t => {
  const f = fixture(t); let sent = 0;
  const adapter = { preflight: async () => {}, send: async raw => {
    strict.equal(f.state().pending.requestHash, hash(raw)); sent++; return good();
  } };
  for (const batch of batches) {
    const result = await executeBatch(f.frozen, batch, f.approval, head, adapter);
    strict.equal(result.completed, 1); strict.equal(result.heldNano, 6337000); lock(f, batch);
  }
  strict.equal(sent, 4); strict.equal(f.state().settledNano, 1_283_925_128);
  await strict.rejects(executeBatch(f.frozen, 'A100', f.approval, head, adapter), /NO_RETRY/);
  strict.equal(sent, 4);
});

test('B cannot dispatch without A anonymous score lock', async t => {
  const f = fixture(t); let sent = 0;
  const adapter = { preflight: async () => {}, send: async () => { sent++; return good(); } };
  await executeBatch(f.frozen, 'A100', f.approval, head, adapter);
  await strict.rejects(executeBatch(f.frozen, 'B100', f.approval, head, adapter));
  strict.equal(sent, 1); strict.equal(f.state().stopped, true);
});

test('request or source ledger drift in preflight stops before a model dispatch', async t => {
  for (const kind of ['request', 'ledger']) await t.test(kind, async t => {
    const f = fixture(t); let sent = 0;
    await strict.rejects(executeBatch(f.frozen, 'A100', f.approval, head, {
      preflight: async () => writeFileSync(kind === 'request' ? join(f.dir, 'A-C001.request.json') : f.ledger, 'changed'),
      send: async () => { sent++; return good(); },
    }), /CHANGED/);
    strict.equal(sent, 0); strict.equal(f.state().pending, null); strict.equal(f.state().stopped, true);
  });
});

test('timeout, unknown cost, over-reserve, HTTP, route, truncation and malformed output hold reserve and stop', async t => {
  const bad = {
    timeout: () => { throw new Error('timeout'); },
    unknown: () => { const r = good(); const b = JSON.parse(r.body); delete b.usage.cost; r.body = JSON.stringify(b); return r; },
    expensive: () => { const r = good(); const b = JSON.parse(r.body); b.usage.cost = 1; r.body = JSON.stringify(b); return r; },
    http: () => ({ status: 403, body: 'denied' }),
    route: () => { const r = good(); r.body = r.body.replace('OpenAI', 'Other'); return r; },
    truncated: () => { const r = good(); r.body = r.body.replace('stop', 'length'); return r; },
    malformed: () => ({ status: 200, body: '{}' }),
  };
  for (const [name, response] of Object.entries(bad)) await t.test(name, async t => {
    const f = fixture(t); let sent = 0;
    const adapter = { preflight: async () => {}, send: async () => { sent++; return response(); } };
    await strict.rejects(executeBatch(f.frozen, 'A100', f.approval, head, adapter));
    strict.equal(f.state().pending.nano, f.rows[0].reserveNano); strict.equal(f.state().heldNano, 6337000);
    strict.equal(f.state().stopped, true);
    await strict.rejects(executeBatch(f.frozen, 'A100', f.approval, head, adapter), /PREVIOUS_STOP/);
    strict.equal(sent, 1);
  });
});

test('preflight rejection never dispatches', async t => {
  const f = fixture(t); let sent = 0;
  await strict.rejects(executeBatch(f.frozen, 'A100', f.approval, head, {
    preflight: async () => { throw new Error('catalog'); }, send: async () => { sent++; return good(); },
  }), /catalog/);
  strict.equal(sent, 0); strict.equal(f.state().pending, null);
});

test('manifest, per-request and special gold corruption cannot load', t => {
  for (const name of ['requests.manifest.json', 'A-C001.request.json', 'special12.json']) {
    const f = fixture(t); writeFileSync(join(f.dir, name), '{}');
    strict.throws(() => loadFrozen(f.dir, f.ledger, f.expected));
  }
});

test('invalid confirmed status, oversized patch and nonempty notes stop; semantic scoring remains separate', () => {
  const output = { inputKind: 'answer', patches: [{ stepId: 'step-1', fieldId: 'goal', value: 'test',
    status: 'confirmed', nature: 'fact', basis: 'user_statement' }], notes: [] };
  function response() {
    const r = good(), b = JSON.parse(r.body); b.choices[0].message.content = JSON.stringify(output);
    return { ...r, body: JSON.stringify(b) };
  }
  strict.throws(() => validateResponse(response()), /PATCH_FORMAT/);
  output.patches[0].status = 'provisional'; output.patches[0].value = 'x'.repeat(401);
  strict.throws(() => validateResponse(response()), /PATCH_FORMAT/);
  output.patches = []; output.notes = ['note']; strict.throws(() => validateResponse(response()), /FORMAT/);
});


test('response evidence failure preserves pending reserve and blocks the next batch', async t => {
  const f = fixture(t); let sent = 0;
  await strict.rejects(executeBatch(f.frozen, 'A100', f.approval, head, {
    preflight: async () => f.write('execution/A-C001.response.json', { preexisting: true }),
    send: async () => { sent++; return good(); },
  }), /EEXIST/);
  strict.equal(sent, 1); strict.equal(f.state().pending.nano, f.rows[0].reserveNano);
  await strict.rejects(executeBatch(f.frozen, 'B100', f.approval, head, {
    preflight: async () => {}, send: async () => { sent++; return good(); },
  }), /PREVIOUS_STOP/);
  strict.equal(sent, 1);
});

test('concurrent batch cannot take the journal while the first send is pending', async t => {
  const f = fixture(t); let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const first = executeBatch(f.frozen, 'A100', f.approval, head, {
    preflight: async () => {}, send: async () => { started(); await new Promise(resolve => { release = resolve; }); return good(); },
  });
  await ready;
  await strict.rejects(executeBatch(f.frozen, 'A100', f.approval, head, {
    preflight: async () => strict.fail('second preflight'), send: async () => strict.fail('second dispatch'),
  }), /EEXIST/);
  release(); await first;
});
