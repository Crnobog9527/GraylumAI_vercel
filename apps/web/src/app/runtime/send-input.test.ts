/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { clearForSend, forgetPending, forgetSentDraft, openingDraft, rememberPending, restoredDraft } from './send-input';

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

it('keeps an unconfirmed send across a reload even after the user overwrote the draft with a new one', () => {
  const storage = memoryStorage();
  storage.setItem('opc-runtime-input:s', '第一条消息');
  rememberPending(storage, 's', 'r1', '第一条消息');
  storage.setItem('opc-runtime-input:s', '新的草稿'); // what updateInput does while the send is pending
  // Reload before the server answered: both texts come back, once, and the pending copy is folded in.
  expect(openingDraft(storage, 's')).toBe('第一条消息\n\n新的草稿');
  expect(storage.map.get('opc-runtime-input:s')).toBe('第一条消息\n\n新的草稿');
  expect(storage.map.has('opc-runtime-pending:s')).toBe(false);
  expect(openingDraft(storage, 's')).toBe('第一条消息\n\n新的草稿');
});

it('opens with the plain draft when nothing is pending, or when the send was confirmed', () => {
  const storage = memoryStorage();
  storage.setItem('opc-runtime-input:s', '草稿');
  expect(openingDraft(storage, 's')).toBe('草稿');
  rememberPending(storage, 's', 'r1', '第一条消息');
  forgetPending(storage, 's');
  expect(openingDraft(storage, 's')).toBe('草稿');
  storage.setItem('opc-runtime-pending:s', 'not json');
  expect(openingDraft(storage, 's')).toBe('草稿');
});

it('does not duplicate the send when the draft key still holds it', () => {
  const storage = memoryStorage();
  storage.setItem('opc-runtime-input:s', '第一条消息');
  rememberPending(storage, 's', 'r1', '第一条消息');
  expect(openingDraft(storage, 's')).toBe('第一条消息');
});
