/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { POSITIONING_MARKER } from '../runtime/positioningFallback';
import { columnStreamer, frameText } from './compareStream';

const frame = (content: string, extra: Record<string, unknown> = {}) => JSON.stringify({ choices: [{ delta: { content, ...extra } }] });
const run = (hold: boolean, frames: string[], refused = false) => {
  const out: string[] = [];
  const stream = columnStreamer({ holdForRefusal: hold, emit: text => out.push(text) });
  for (const f of frames) stream.onChunk(f);
  stream.settle(refused);
  return { out, text: stream.text() };
};

describe('compare column stream (FUSION-COMPARE §3.5)', () => {
  it('takes only the visible content of a frame: no reasoning, tools, usage or protocol', () => {
    expect(frameText(frame('你好'))).toBe('你好');
    expect(frameText(JSON.stringify({ choices: [{ delta: { reasoning: '想一想', content: 'x' } }] }))).toBe('x');
    expect(frameText(JSON.stringify({ choices: [{ delta: { reasoning: '想一想' } }] }))).toBe('');
    expect(frameText(JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: 'a' } }] } }] }))).toBe('');
    expect(frameText(JSON.stringify({ usage: { total_tokens: 3 }, choices: [] }))).toBe('');
    for (const bad of ['', '[DONE]', 'not json', '{', 'null', '[]', '{"choices":"x"}', '{"choices":[null,{"delta":null}]}']) expect(frameText(bad)).toBe('');
  });
  it('forwards the answer as it arrives, in order, with no browser-visible protocol', () => {
    expect(run(false, [frame('你'), frame('好'), '[DONE]']).out).toEqual(['你', '好']);
    expect(run(false, [JSON.stringify({ usage: {} }), frame('a')]).out).toEqual(['a']);
  });
  it('a column without the fallback rule never holds anything back, even text that looks like the marker', () => {
    expect(run(false, [frame(POSITIONING_MARKER.slice(0, 5))]).out).toEqual([POSITIONING_MARKER.slice(0, 5)]);
  });
  it('a column with the fallback rule holds the start only while it could still become the marker', () => {
    const half = POSITIONING_MARKER.slice(0, 6);
    const held = run(true, [frame(half)], false);
    expect(held.text).toBe(half);
    expect(held.out).toEqual([half]); // released at settle: it never became the marker
    const visible = run(true, [frame('你好，'), frame('世界')]);
    expect(visible.out).toEqual(['你好，', '世界']); // released as soon as it cannot be the marker
    const progressive = run(true, [frame(half), frame('XYZ'), frame('more')]);
    expect(progressive.out).toEqual([half + 'XYZ', 'more']);
  });
  it('a refused column shows nothing at all and keeps nothing: not the marker, not a leading space, not a split marker', () => {
    expect(run(true, [frame(POSITIONING_MARKER)], true).out).toEqual([]);
    expect(run(true, [frame('  '), frame(POSITIONING_MARKER.slice(0, 7)), frame(POSITIONING_MARKER.slice(7))], true).out).toEqual([]);
    expect(run(true, [frame(POSITIONING_MARKER + ' 以及别的字')], true).out).toEqual([]);
    // Even if the executor settles it as refused only at the end, what was already held is dropped.
    expect(run(true, [frame(POSITIONING_MARKER.slice(0, 10))], true).out).toEqual([]);
  });
  it('an answer that merely begins with whitespace or other text is not held', () => {
    expect(run(true, [frame('\n\n'), frame('答案')]).out).toEqual(['\n\n答案']);
    expect(run(true, [frame('[[GRAYLUM_OTHER]] 内容')]).out).toEqual(['[[GRAYLUM_OTHER]] 内容']);
  });
});
