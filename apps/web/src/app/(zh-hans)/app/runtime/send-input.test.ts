/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import {
  clearForSend, forgetPending, markPendingRestored, markPendingSeen, openingDraft, pendingSeen, readPending, rememberPending, requestIdFor,
  restoredDraft, withoutSentText,
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

it('gives an edited resend a new id instead of the address id of the unanswered send', () => {
  const storage = memoryStorage();
  rememberPending(storage, 's', send('第一条消息'));
  const pending = readPending(storage, 's');
  expect(requestIdFor('r1', pending, '第一条消息', () => 'fresh')).toBe('r1'); // unchanged: replay
  expect(requestIdFor('r1', pending, '第一条消息，改过', () => 'fresh')).toBe('fresh'); // edited: a new message
  expect(requestIdFor('other', pending, '第一条消息，改过', () => 'fresh')).toBe('other'); // e.g. the new-task hand-off
  expect(requestIdFor('from-url', null, '任何内容', () => 'fresh')).toBe('from-url');
  expect(requestIdFor(null, null, '任何内容', () => 'fresh')).toBe('fresh');
});

const at = Date.parse('2026-11-01T10:00:00Z');
const quiet = { activeTurn: null, lastTurn: null, messages: [] as { role: string; content: string }[] };
it('a send whose turn is running or stored on the server is seen after a reload, a lost one is not', () => {
  const pending = { text: '第二条', at };
  // Running: opened at about the time of the send (a minute either way covers the clocks).
  expect(pendingSeen(pending, { ...quiet, activeTurn: { openedAt: '2026-11-01T10:00:01Z' } })).toBe('running');
  // An older turn that is still running says nothing about this send.
  expect(pendingSeen(pending, { ...quiet, activeTurn: { openedAt: '2026-11-01T09:00:00Z' } })).toBe('unknown');
  // Stored: the last asked text is the sent text and its turn closed after the send.
  const stored = { activeTurn: null, lastTurn: { closedAt: '2026-11-01T10:00:09Z' },
    messages: [{ role: 'user', content: '第一条' }, { role: 'assistant', content: 'a' }, { role: 'user', content: ' 第二条 ' }, { role: 'assistant', content: 'b' }] };
  expect(pendingSeen(pending, stored)).toBe('stored');
  // The same words asked earlier (a turn closed long before the send) do not make a lost send stored.
  expect(pendingSeen(pending, { ...stored, lastTurn: { closedAt: '2026-11-01T08:00:00Z' } })).toBe('unknown');
  expect(pendingSeen(pending, { ...stored, messages: stored.messages.slice(0, 2) })).toBe('unknown');
  expect(pendingSeen(pending, quiet)).toBe('unknown');
});

it('takes the put-back text out of the box, keeping a newer draft typed after it', () => {
  expect(withoutSentText('第二条', '第二条')).toBe('');
  expect(withoutSentText('第二条\n\n新的草稿', '第二条')).toBe('新的草稿');
  expect(withoutSentText('另一段', '第二条')).toBe('另一段');
});

it('marks a pending send seen without touching the rest of its record', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  rememberPending(storage, 's', { requestId: 'r', text: '第二条', input: '第二条' });
  markPendingSeen(storage, 's');
  expect(readPending(storage, 's')).toMatchObject({ requestId: 'r', text: '第二条', seen: true });
});
