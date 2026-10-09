/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CDC-WRITEBACK-V3 evaluation: shared paths, pins and pure request helpers. No network, no credentials.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

export const repo = fileURLToPath(new URL('../..', import.meta.url));
const home = userInfo().homedir;
export const paths = Object.freeze({
  // Original 100 cases, gold and frozen mentor replies (2026-10-06 baseline).
  baseline: join(home, '.graylum/cdc-writeback-v2-20261006'),
  // 4096 re-run: frozen B requests (77/100), special gold, host plan and the final shared ledger.
  source: join(home, '.graylum/cdc-writeback-v2-4096-20261009'),
  root: join(home, '.graylum/cdc-writeback-v3-20261010'),
});
export const pins = Object.freeze({
  casesHash: '8258d5753b4a8626a26234246c37e9e3a9cd3c94f24bf86ea4c96b7303b6f76f',
  sourceManifestHash: '274f1b5d3f8052e773ec7661dde5d35f5a1f45f5a7b58911f7a4af055b848291',
  specialHash: '9c29090a99ff60584c7265f5bfc5eceff7e71d9be334bcbe2527422d9e822c7e',
  // Stopped 4096 ledger: every earlier settlement and unknown hold is carried, nothing is released.
  sourceLedgerHash: 'dd162ab6622bcaa142c53388e304bfc316889597866f1365a73d751d8e17bcaa',
  settledNano: 1_401_249_670, heldNano: 20_799_750, capNano: 5_000_000_000,
});
export const runs = Object.freeze(['R1', 'R2', 'R3']);
export const batches = Object.freeze([...runs, 'S12']);
export const outputTokens = 4096;
export const marker = '\n\nPrimary assistant reply:\n';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function assert(condition, code) { if (!condition) throw new Error(code); }
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
// Same conservative bound as the 4096 run: full input bytes plus 8192, full output, no cache discount.
export const reserveNano = bytes => (bytes + 8192) * 250 + outputTokens * 750;

/** The exact ORGANIZER_INSTRUCTIONS value of a checked-in organizerPrompt.ts source (pure string expression). */
export function organizerInstructions(source) {
  const start = source.indexOf('export const ORGANIZER_INSTRUCTIONS = ');
  const end = source.indexOf(';\n', start);
  assert(start >= 0 && end > start, 'V3_PROMPT_SOURCE');
  const expression = source.slice(start + 'export const ORGANIZER_INSTRUCTIONS = '.length, end);
  // Evaluated with no globals: the checked-in value is a pure string-array expression.
  const value = runInNewContext('(' + expression + ')', Object.create(null), { timeout: 1000 });
  assert(typeof value === 'string' && value.includes('pendingSuggestion') && value.includes('withdrawals'), 'V3_PROMPT_VALUE');
  return value;
}

/** Splits a frozen organizer request; serialization must round-trip byte for byte. */
export function splitRequest(raw) {
  const body = JSON.parse(raw);
  assert(JSON.stringify(body) === raw && body.messages?.length === 2, 'V3_REQUEST_ROUNDTRIP');
  const content = body.messages[1].content, index = content.indexOf(marker);
  assert(index > 0, 'V3_REQUEST_FORMAT');
  const text = content.slice(0, index), context = JSON.parse(text);
  assert(JSON.stringify(context) === text, 'V3_CONTEXT_ROUNDTRIP');
  return { body, context, tail: content.slice(index) };
}

/** Adds each seeded pending suggestion exactly where captureOrganizerInput puts it: last key of the field. */
export function withPending(context, initial) {
  const result = structuredClone(context);
  for (const row of initial.filter(item => item.suggestion)) {
    const field = result.checklist.find(step => step.id === row.stepId)?.fields.find(item => item.id === row.fieldId);
    assert(field && !('pendingSuggestion' in field), 'V3_PENDING_FIELD');
    const { value, nature, basis } = row.suggestion;
    assert(typeof value === 'string' && value.trim(), 'V3_PENDING_VALUE');
    field.pendingSuggestion = { value, nature, basis };
  }
  return result;
}

/** Removes pendingSuggestion; used to prove the V3 user payload adds nothing else. */
export function withoutPending(context) {
  const result = structuredClone(context);
  for (const step of result.checklist) for (const field of step.fields) delete field.pendingSuggestion;
  return result;
}

/** Normalized comparison of the host-built organizer payload with a frozen request (key order is irrelevant). */
export function sameUserContent(hostRaw, frozenRaw) {
  const read = raw => {
    const content = JSON.parse(raw).messages.at(-1).content, index = content.indexOf(marker);
    assert(index > 0, 'V3_REPLAY_FORMAT');
    return JSON.stringify(canonical(JSON.parse(content.slice(0, index)))) + content.slice(index);
  };
  return read(hostRaw) === read(frozenRaw);
}

/** Stops on any output the host could not apply as a whole; withdrawals mirror the 0199 SQL shape check. */
export function validateV3Response(response, base) {
  const cost = base(response);
  const output = JSON.parse(JSON.parse(response.body).choices[0].message.content);
  assert(output.withdrawals === undefined || (Array.isArray(output.withdrawals) && output.withdrawals.length <= 12 &&
    output.withdrawals.every(w => w && typeof w === 'object' && typeof w.stepId === 'string' && typeof w.fieldId === 'string')),
  'WITHDRAWAL_FORMAT_STOP');
  return cost;
}
