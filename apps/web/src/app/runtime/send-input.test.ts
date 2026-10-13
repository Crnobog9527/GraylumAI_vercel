/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import {
  clearForSend, markPendingRestored, openingDraft, pendingWasStored, readPending, rememberPending, requestIdFor, restoredDraft,
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

it('restores the failed message in front of any new draft, even one that reads the same', () => {
  expect(restoredDraft('好的，我再补充一点', '好')).toBe('好\n\n好的，我再补充一点');
  expect(restoredDraft('', '第一条消息')).toBe('第一条消息');
  // The box was emptied on send, so an identical "继续" in it now is the user's next message, not a copy.
  expect(restoredDraft('继续', '继续')).toBe('继续\n\n继续');
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
  rememberPending(storage, 's', { requestId: 'r1', text: '第一条消息', input: '第一条消息' }, [], T0);
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
  rememberPending(storage, 's', { requestId: 'r1', text: '第一条消息', input: '第一条消息' }, [], T0);
  const box = { value: openingDraft(storage, 's') };
  settlePending(storage, 's', [{ input: '第一条消息', createdAt: at(800) }], f => { box.value = f(box.value); });
  expect(box.value).toBe('');
  expect(storage.map.has('opc-runtime-pending:s')).toBe(false);
  expect(storage.map.has('opc-runtime-input:s')).toBe(false);
  expect(requestIdFor(null, readPending(storage, 's'), '第一条消息', () => 'fresh')).toBe('fresh');
});

it('counts identical turns, so an earlier "继续" cannot vouch for a newer one that failed', () => {
  const storage = memoryStorage();
  const earlier = [{ input: '继续', createdAt: at(-30_000) }];
  rememberPending(storage, 's', { requestId: 'r2', text: '继续', input: '继续' }, earlier, T0);
  expect(readPending(storage, 's')?.seen).toBe(1);
  const box = { value: '' };
  const set = (f: (v: string) => string) => { box.value = f(box.value); };
  settlePending(storage, 's', earlier, set); // still one: the second 继续 was not stored, it comes back
  expect(box.value).toBe('继续');
  expect(requestIdFor(null, readPending(storage, 's'), '继续', () => 'fresh')).toBe('r2');
  settlePending(storage, 's', [...earlier, { input: '继续', createdAt: at(500) }], set); // now two: stored
  expect(readPending(storage, 's')).toBeNull();
  // Without a count from send time, only a turn from about then counts.
  const unknown = { requestId: 'r3', text: '继续', input: '继续', at: T0, seen: null };
  expect(pendingWasStored(unknown, [{ input: '继续', createdAt: at(-3_600_000) }])).toBe(false);
  expect(pendingWasStored(unknown, [{ input: '继续', createdAt: at(-60_000) }])).toBe(true);
});

it('keeps a draft that only happens to begin with the sent text when it was never put back', () => {
  const storage = memoryStorage();
  rememberPending(storage, 's', { requestId: 'r1', text: '好', input: '好' }, [], T0);
  storage.setItem('opc-runtime-input:s', '好\n\n我自己又写了这段');
  const box = { value: openingDraft(storage, 's') };
  settlePending(storage, 's', [{ input: '好', createdAt: at(300) }], f => { box.value = f(box.value); });
  expect(box.value).toBe('好\n\n我自己又写了这段');
  expect(storage.map.get('opc-runtime-input:s')).toBe('好\n\n我自己又写了这段');
  expect(withoutSent('继续\n\n下一句', '继续')).toBe('下一句');
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
  rememberPending(storage, 's', { requestId: 'r1', text: '第一条消息', input: '第一条消息' }, [], T0);
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
  rememberPending(storage, 's', { requestId: 'r1', text: '第一条消息', input: '第一条消息' }, [], T0);
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

/** Send "继续", then type "继续" again while it is pending (updateInput saves it under the draft key). */
function sendThenRetypeSame() {
  const storage = memoryStorage();
  storage.setItem('opc-runtime-input:s', '继续');
  rememberPending(storage, 's', { requestId: 'r1', text: '继续', input: '继续' }, [], T0);
  expect(storage.map.has('opc-runtime-input:s')).toBe(false); // the sent text now lives only in the record
  storage.setItem('opc-runtime-input:s', '继续');
  return storage;
}

it('keeps an identical next draft typed while a send was pending when that send is stored', () => {
  const storage = sendThenRetypeSame();
  const shown = { value: '继续' };
  settlePending(storage, 's', [{ input: '继续', createdAt: at(400) }], f => { shown.value = f(shown.value); });
  expect(shown.value).toBe('继续');
  expect(storage.map.get('opc-runtime-input:s')).toBe('继续');
});

it('brings back both copies when that send was not stored', () => {
  const storage = sendThenRetypeSame();
  const box = { value: openingDraft(storage, 's') };
  settlePending(storage, 's', [], f => { box.value = f(box.value); });
  expect(box.value).toBe('继续\n\n继续');
});
