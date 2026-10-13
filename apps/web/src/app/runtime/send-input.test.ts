/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import {
  clearForSend, forgetPending, markPendingRestored, openingDraft, readPending, rememberPending, requestIdFor, restoredDraft,
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
const send = (text: string, requestId = 'r1') => ({ requestId, text, input: text });

it('moves the sent text out of the draft into its own record, which keeps the request id', () => {
  const storage = memoryStorage();
  storage.setItem('opc-runtime-input:s', '第一条消息');
  rememberPending(storage, 's', send('第一条消息'));
  expect(storage.map.has('opc-runtime-input:s')).toBe(false);
  expect(readPending(storage, 's')).toMatchObject({ requestId: 'r1', text: '第一条消息', input: '第一条消息' });
  forgetPending(storage, 's'); // what a definite answer (stored or refused) does
  expect(readPending(storage, 's')).toBeNull();
});

it('after a reload puts an unanswered send back once, in front of a draft typed meanwhile', () => {
  const storage = memoryStorage();
  rememberPending(storage, 's', send('第一条消息'));
  storage.setItem('opc-runtime-input:s', '新的草稿'); // updateInput while the send was pending
  expect(openingDraft(storage, 's')).toBe('第一条消息\n\n新的草稿');
  expect(storage.map.get('opc-runtime-input:s')).toBe('第一条消息\n\n新的草稿');
  expect(openingDraft(storage, 's')).toBe('第一条消息\n\n新的草稿'); // a second reload adds nothing
});

it('keeps an identical next draft: sending "继续" and typing "继续" again leaves both', () => {
  const storage = memoryStorage();
  rememberPending(storage, 's', send('继续'));
  storage.setItem('opc-runtime-input:s', '继续');
  expect(openingDraft(storage, 's')).toBe('继续\n\n继续');
});

it('never drops the record on a guess, so resending the unchanged text replays the same request', () => {
  const storage = memoryStorage();
  rememberPending(storage, 's', send('第一条消息'));
  // Reopened through a link without ?request=, whether or not the server had stored it.
  expect(openingDraft(storage, 's')).toBe('第一条消息');
  expect(requestIdFor(null, readPending(storage, 's'), '第一条消息', () => 'fresh')).toBe('r1');
  expect(requestIdFor(null, readPending(storage, 's'), '第一条消息 改过', () => 'fresh')).toBe('fresh');
  expect(requestIdFor('from-url', readPending(storage, 's'), '第一条消息', () => 'fresh')).toBe('from-url');
});

it('after an error with an unknown outcome the text is already back, so a reload does not add it again', () => {
  const storage = memoryStorage();
  rememberPending(storage, 's', send('第一条消息'));
  storage.setItem('opc-runtime-input:s', '第一条消息'); // clearForSend's save callback
  markPendingRestored(storage, 's');
  expect(openingDraft(storage, 's')).toBe('第一条消息');
  expect(requestIdFor(null, readPending(storage, 's'), '第一条消息', () => 'fresh')).toBe('r1');
});

it('opens with the plain draft and ignores a broken record', () => {
  const storage = memoryStorage();
  storage.setItem('opc-runtime-input:s', '草稿');
  storage.setItem('opc-runtime-pending:s', 'not json');
  expect(openingDraft(storage, 's')).toBe('草稿');
  expect(readPending(storage, 's')).toBeNull();
});
