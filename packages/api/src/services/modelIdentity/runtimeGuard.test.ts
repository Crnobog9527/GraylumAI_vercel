/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { BRAND_REPLY_EN, BRAND_REPLY_ZH } from './brandIdentity';
import { guardedProgress, runtimeIdentityGuard } from './runtimeGuard';
import { leaksModelIdentity } from './outputGuard';
import { NativeProgressProjection, NativeTextTransport, type NativeTextUpdate } from '../runtime/nativeProgress';
import type { RuntimeProgress } from '../runtime/progress';

/** Rebuild what the browser shows from textDelta events (offset/rev protocol). */
function client() {
  let shown = '';
  return {
    apply(event: { offset: number; text: string } | null) {
      if (!event) return;
      shown = Array.from(shown).slice(0, event.offset).join('') + event.text;
    },
    get shown() { return shown; },
  };
}

function stream(chunks: string[], finalText?: string) {
  const projection = new NativeProgressProjection({ mode: 'agent' });
  const transport = new NativeTextTransport(), view = client(), seen: string[] = [];
  const guarded = guardedProgress(event => { if (event.type === 'text' && 'delta' in event) transport.push(event); });
  for (const chunk of chunks) {
    const update = projection.appendText(chunk);
    if (update) guarded(update);
    view.apply(transport.flush());
    seen.push(view.shown);
  }
  const final = projection.finish(finalText ?? projection.text);
  if (final) guarded(final);
  guarded({ type: 'phase', phase: 'saving' });
  view.apply(transport.flush());
  seen.push(view.shown);
  return { seen, shown: view.shown };
}

it('native streaming never shows a leak at any chunk and ends with the brand reply', () => {
  const text = '你好！我是由 Google 训练的大型语言模型。下面是你的三个选题建议：开箱、对比、教程。';
  const result = stream(Array.from(text));
  for (const shown of result.seen) expect(leaksModelIdentity(shown), shown).toBe(false);
  expect(result.shown).toBe(`你好！${BRAND_REPLY_ZH}下面是你的三个选题建议：开箱、对比、教程。`);
});

it('a held first-person tail is released on flush when it turns out harmless', () => {
  const result = stream(['好的。', '我建议', '你每周发三条']);
  expect(result.shown).toBe('好的。我建议你每周发三条');
});

it('English leak in larger chunks is replaced before the client sees it', () => {
  const result = stream(['Sure. I am Cla', 'ude, made by Anthropic. ', 'Here is your plan.']);
  for (const shown of result.seen) expect(shown).not.toMatch(/Claude|Anthropic/);
  expect(result.shown).toBe(`Sure. ${BRAND_REPLY_EN} Here is your plan.`);
});

it('legacy cumulative text events and card messages are redacted', () => {
  const out: RuntimeProgress[] = [];
  const guarded = guardedProgress(event => out.push(event));
  guarded({ type: 'text', text: '我是 Claude。' });
  guarded({ type: 'card', card: { message: '我是 Claude。', questions: [] } as never });
  expect(out).toEqual([
    { type: 'text', text: BRAND_REPLY_ZH },
    { type: 'card', card: { message: BRAND_REPLY_ZH, questions: [] } },
  ]);
});

it('a source switch is always sent as a replacement', () => {
  const out: NativeTextUpdate[] = [];
  const guarded = guardedProgress(event => out.push(event as NativeTextUpdate));
  guarded({ type: 'text', text: '第一段。', delta: '第一段。', replace: true, source: 'assistant' });
  guarded({ type: 'text', text: '第一段。第二', delta: '第一段。第二', replace: false, source: 'message' });
  expect(out.at(-1)).toMatchObject({ replace: true, text: '第一段。第二', source: 'message' });
});

it('switch off passes events and bodies through untouched', async () => {
  const guard = await runtimeIdentityGuard({ rpc: async () => ({ data: { version: 1, enabled: false, revision: 1,
    updatedBy: null, updatedAt: null }, error: null }) });
  const emit: (event: RuntimeProgress) => void = () => {};
  expect(guard.progress(emit)).toBe(emit);
  expect(guard.body('我是 Claude。')).toBe('我是 Claude。');
});
