/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { TurnStop } from '../call';
import type { RuntimeTool } from '../agent/runner';
import type { StepEvent } from '../sse';
import { withStepEvents } from './announce';

const tool = (name: string, execute: RuntimeTool['execute']): RuntimeTool => ({ name, description: name, parameters: {}, execute } as unknown as RuntimeTool);

describe('withStepEvents', () => {
  it('announces start and end of each tool under one id and keeps the result', async () => {
    const events: StepEvent[] = [];
    const [first, second] = withStepEvents([tool('read_skill_file', async () => '{"path":"a.md"}'),
      tool('benchmark_fetch', async () => '{"status":"ok","items":[1,2,3]}')], event => events.push(event), new Set());
    expect(await first!.execute({ path: 'a.md' }, 'c1')).toBe('{"path":"a.md"}');
    await second!.execute({ keywords: ['早起'] }, 'c2');
    expect(events).toEqual([
      { type: 'step', id: '1', tool: 'load_skill', state: 'running' }, { type: 'step', id: '1', tool: 'load_skill', state: 'done' },
      { type: 'step', id: '2', tool: 'research', detail: '早起', state: 'running' },
      { type: 'step', id: '2', tool: 'research', detail: '早起', state: 'done', count: 3 },
    ]);
  });

  it('names the method a skill file belongs to, by the given user-facing name and never by its path', async () => {
    const events: StepEvent[] = [];
    const [read] = withStepEvents([tool('read_skill_file', async () => '{}')], event => events.push(event), new Set(), undefined, '账号定位');
    await read!.execute({ path: 'references/step-2.md' }, 'c1');
    expect(events).toEqual([
      { type: 'step', id: '1', tool: 'load_skill', label: '账号定位', state: 'running' },
      { type: 'step', id: '1', tool: 'load_skill', label: '账号定位', state: 'done' },
    ]);
    expect(JSON.stringify(events)).not.toContain('step-2');
    // Without a name the step is still shown, unnamed (no path, no id).
    const plain: StepEvent[] = [];
    await withStepEvents([tool('read_skill_file', async () => '{}')], event => plain.push(event), new Set())[0]!.execute({ path: 'a/b.md' }, 'c');
    expect(plain[0]).toEqual({ type: 'step', id: '1', tool: 'load_skill', state: 'running' });
  });

  it('a skill file read reports on the method line the turn already opened (same id); other tools keep counting from 1', async () => {
    const events: StepEvent[] = [];
    const [read, search] = withStepEvents([tool('read_skill_file', async () => '{}'), tool('web_search', async () => '{"status":"ok"}')],
      event => events.push(event), new Set(), undefined, '账号定位', 'method');
    await read!.execute({ path: 'references/step-2.md' }, 'c1');
    await search!.execute({ query: 'x' }, 'c2');
    expect(events.map(e => [e.id, e.tool, e.state])).toEqual([['method', 'load_skill', 'running'], ['method', 'load_skill', 'done'],
      ['1', 'research', 'running'], ['1', 'research', 'done']]);
    expect(events[0]).toMatchObject({ label: '账号定位' });
  });

  it('shows no step for the question card, and passes it through untouched', async () => {
    const events: StepEvent[] = [];
    const card = tool('ask_question', async () => 'card');
    const [wrapped] = withStepEvents([card], event => events.push(event), new Set());
    expect(wrapped).toBe(card);
    expect(events).toEqual([]);
  });

  it('a failing tool shows a failed step, hands a TurnStop to onStop and rethrows the same error', async () => {
    const events: StepEvent[] = [], stops: TurnStop[] = [];
    const stop = new TurnStop('TURN_PAUSED' as never);
    const [wrapped] = withStepEvents([tool('web_search', async () => { throw stop; })], event => events.push(event), new Set(), s => stops.push(s));
    await expect(wrapped!.execute({ query: 'x' }, 'c')).rejects.toBe(stop);
    expect(stops).toEqual([stop]);
    expect(events.at(-1)).toMatchObject({ id: '1', tool: 'research', state: 'failed' });
  });

  it('an announcing that throws never changes what the tool does', async () => {
    const [wrapped] = withStepEvents([tool('web_search', async () => '{"status":"ok"}')], () => { throw new Error('page gone'); }, new Set());
    expect(await wrapped!.execute({ query: 'x' }, 'c')).toBe('{"status":"ok"}');
  });
});
