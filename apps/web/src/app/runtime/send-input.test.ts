/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { clearForSend, forgetSentDraft } from './send-input';

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

it('does not overwrite text the user typed while the send was pending', () => {
  const input = box('第一条消息');
  const restore = clearForSend(input.set, '第一条消息');
  input.set(() => '新的草稿');
  restore();
  expect(input.state.value).toBe('新的草稿');
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
