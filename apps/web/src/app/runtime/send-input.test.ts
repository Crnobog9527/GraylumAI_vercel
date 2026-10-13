/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import {
  clearForSend, forgetSentDraft, markPendingRestored, openingDraft, pendingWasStored, readPending, rememberPending, requestIdFor, restoredDraft,
  settlePending, withoutSent,
} from './send-input';

function box(initial: string) {
  const state = { value: initial };
  return { state, set: (update: (current: string) => string) => { state.value = update(state.value); } };
}

it('empties the box at once and puts the text back when the send is not stored', () => {
  const input = box('第一条消息');
  const restore = clearForSend(input.set, '第一条消息');
  expect(input.state.value).toBe('');
  restore();
  expect(input.state.value).toBe('第一条消息');
});

it('keeps both the failed message and a draft typed while it was pending, and saves them', () => {
  const input = box('第一条消息');
  const saved: string[] = [];
  const restore = clearForSend(input.set, '第一条消息', text => saved.push(text));
  input.set(() => '新的草稿');
  restore();
  expect(input.state.value).toBe('第一条消息\n\n新的草稿');
  expect(saved).toEqual(['第一条消息\n\n新的草稿']);
});

it('restores the failed message even when the new draft happens to begin with it', () => {
  expect(restoredDraft('好的，我再补充一点', '好')).toBe('好\n\n好的，我再补充一点');
  expect(restoredDraft('', '第一条消息')).toBe('第一条消息');
  expect(restoredDraft('第一条消息', '第一条消息')).toBe('第一条消息');
});

it('drops the saved draft only while it is still the sent message', () => {
  const saved = new Map([['k', '第一条消息']]);
  const storage = { getItem: (k: string) => saved.get(k) ?? null, removeItem: (k: string) => { saved.delete(k); } };
  forgetSentDraft(storage, 'k', '第一条消息');
  expect(saved.has('k')).toBe(false);
  saved.set('k', '新的草稿');
  forgetSentDraft(storage, 'k', '第一条消息');
  expect(saved.get('k')).toBe('新的草稿');
});

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); } };
}
const T0 = Date.parse('2026-10-14T08:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

it('keeps an unconfirmed send across a reload even after the user overwrote the draft with a new one', () => {
  const storage = memoryStorage();
  rememberPending(storage, 's', { requestId: 'r1', text: '第一条消息', input: '第一条消息' }, T0);
  storage.setItem('opc-runtime-input:s', '新的草稿'); // what updateInput does while the send is pending
  // Reload: the page opens with the draft; the server history (not stored) puts the send back in front, once.
  const box = { value: openingDraft(storage, 's') };
  const set = (f: (v: string) => string) => { box.value = f(box.value); };
  expect(box.value).toBe('新的草稿');
  settlePending(storage, 's', [], set);
  settlePending(storage, 's', [], set);
  expect(box.value).toBe('第一条消息\n\n新的草稿');
  expect(storage.map.get('opc-runtime-input:s')).toBe('第一条消息\n\n新的草稿');
  // The record (and its request id) stays, so resending the same input replays instead of charging twice.
  expect(requestIdFor(null, readPending(storage, 's'), '第一条消息', () => 'fresh')).toBe('r1');
  expect(requestIdFor(null, readPending(storage, 's'), '第一条消息\n\n新的草稿', () => 'fresh')).toBe('fresh');
  expect(requestIdFor('from-url', readPending(storage, 's'), '第一条消息', () => 'fresh')).toBe('from-url');
});

it('drops a send the server already stored, so reopening without ?request= cannot run and bill it again', () => {
  const storage = memoryStorage();
  storage.setItem('opc-runtime-input:s', '第一条消息');
  rememberPending(storage, 's', { requestId: 'r1', text: '第一条消息', input: '第一条消息' }, T0);
  const box = { value: openingDraft(storage, 's') };
  settlePending(storage, 's', [{ input: '第一条消息', createdAt: at(800) }], f => { box.value = f(box.value); });
  expect(box.value).toBe('');
  expect(storage.map.has('opc-runtime-pending:s')).toBe(false);
  expect(storage.map.has('opc-runtime-input:s')).toBe(false);
  expect(requestIdFor(null, readPending(storage, 's'), '第一条消息', () => 'fresh')).toBe('fresh');
});

it('keeps a draft typed after a stored send, and ignores an older identical message', () => {
  const pending = { requestId: 'r1', text: '继续', input: '继续', at: T0 };
  expect(pendingWasStored(pending, [{ input: '继续', createdAt: at(-3_600_000) }])).toBe(false);
  expect(pendingWasStored(pending, [{ input: '继续', createdAt: at(-60_000) }])).toBe(true);
  expect(withoutSent('继续\n\n下一句', '继续')).toBe('下一句');
  expect(withoutSent('别的内容', '继续')).toBe('别的内容');
});

it('opens with the plain draft and ignores a broken pending record', () => {
  const storage = memoryStorage();
  storage.setItem('opc-runtime-input:s', '草稿');
  storage.setItem('opc-runtime-pending:s', 'not json');
  expect(openingDraft(storage, 's')).toBe('草稿');
  expect(readPending(storage, 's')).toBeNull();
});

it('keeps the request id after an error with an unknown outcome, so a resend from any link replays', () => {
  const storage = memoryStorage();
  rememberPending(storage, 's', { requestId: 'r1', text: '第一条消息', input: '第一条消息' }, T0);
  // prepare failed without an answer (it may have been stored): text back in the box, record kept.
  storage.setItem('opc-runtime-input:s', '第一条消息');
  markPendingRestored(storage, 's');
  expect(readPending(storage, 's')).toMatchObject({ requestId: 'r1', restored: true });
  // Reopened without ?request=: no second copy is merged in, and resending the same text reuses r1.
  const box = { value: openingDraft(storage, 's') };
  settlePending(storage, 's', [], f => { box.value = f(box.value); });
  expect(box.value).toBe('第一条消息');
  expect(requestIdFor(null, readPending(storage, 's'), '第一条消息', () => 'fresh')).toBe('r1');
});

it('saves the draft without the sent text before dropping the record when history later shows it stored', () => {
  const storage = memoryStorage();
  rememberPending(storage, 's', { requestId: 'r1', text: '第一条消息', input: '第一条消息' }, T0);
  storage.setItem('opc-runtime-input:s', '新的草稿');
  const box = { value: openingDraft(storage, 's') };
  const set = (f: (v: string) => string) => { box.value = f(box.value); };
  settlePending(storage, 's', [], set); // first poll: not there yet, so it is put back in front
  expect(storage.map.get('opc-runtime-input:s')).toBe('第一条消息\n\n新的草稿');
  settlePending(storage, 's', [{ input: '第一条消息', createdAt: at(1000) }], set); // a later poll finds it
  expect(box.value).toBe('新的草稿');
  expect(storage.map.get('opc-runtime-input:s')).toBe('新的草稿');
  expect(storage.map.has('opc-runtime-pending:s')).toBe(false);
  // A reload now opens only the new draft; the sent text cannot come back without its request id.
  expect(openingDraft(storage, 's')).toBe('新的草稿');
});
