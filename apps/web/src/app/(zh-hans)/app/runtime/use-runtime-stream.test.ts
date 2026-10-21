/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { AgentTurnEvent, AgentTurnOutcome } from '@repo/api/src/shared/agentTurn';
import type { LiveReply } from '@/app/(zh-hans)/app/positioning/[draftId]/agent-turn-display';
import { liveReplyController } from '@/app/(zh-hans)/app/positioning/[draftId]/live-reply-controller';
import { STREAM_INTERRUPTED } from '@/app/(zh-hans)/app/positioning/[draftId]/mentor-turn';
import { runStreamedExecution } from './use-runtime-stream';
import { liveReplyText, liveScrollSignature, withResumeStop } from './runtime-live-reply';

const ID = '00000000-0000-4000-8000-000000000001';
const delta = (text: string, offset: number): AgentTurnEvent => ({ type: 'textDelta', text, offset, rev: 1, source: 'assistant' });
const completed: AgentTurnOutcome = { state: 'completed', body: '你好，连通正常。' };

function fixture() {
  const shown: Array<LiveReply | null> = [];
  const live = liveReplyController({ draftId: 'runtime:s', storage: () => null, show: reply => shown.push(reply) });
  const handlers = { onResult: vi.fn(), refreshBalance: vi.fn() };
  return { shown, live, handlers };
}

async function* events(list: AgentTurnEvent[], gate?: Promise<void>, after?: AgentTurnEvent[]) {
  for (const event of list) yield event;
  if (gate) await gate;
  for (const event of after ?? []) yield event;
}

describe('runStreamedExecution (runtime.executeStream on /runtime)', () => {
  it('shows text as it arrives, then returns the result and re-reads the balance', async () => {
    const { shown, live, handlers } = fixture();
    const open = vi.fn(async () => events([delta('你好，', 0), delta('连通', 3), delta('正常。', 5), { type: 'result', result: completed }]));
    await expect(runStreamedExecution(live, open, ID, handlers)).resolves.toEqual(completed);
    expect(open).toHaveBeenCalledWith(ID);
    expect(shown.map(reply => reply?.text)).toEqual(['', '你好，', '你好，连通', '你好，连通正常。', '你好，连通正常。']);
    expect(shown.at(-1)).toMatchObject({ executionId: ID, finished: true });
    expect(handlers.onResult).toHaveBeenCalledWith(ID, completed);
    expect(handlers.refreshBalance).toHaveBeenCalledTimes(1);
  });

  it('a lost stream throws like a lost execute response, keeps the shown text waiting and still re-reads the balance', async () => {
    const { live, handlers } = fixture();
    const open = async () => events([delta('部分', 0)]);
    await expect(runStreamedExecution(live, open, ID, handlers)).rejects.toThrow(STREAM_INTERRUPTED);
    expect(live.current()).toMatchObject({ text: '部分', phase: 'waiting', stalled: true });
    expect(handlers.onResult).not.toHaveBeenCalled();
    expect(handlers.refreshBalance).toHaveBeenCalledTimes(1);
  });

  it('a refused stream request surfaces its error and still re-reads the balance', async () => {
    const { live, handlers } = fixture();
    const refused = Object.assign(new Error('RUNTIME_RESUME_CONFLICT'), { data: { httpStatus: 409 } });
    await expect(runStreamedExecution(live, async () => { throw refused; }, ID, handlers)).rejects.toBe(refused);
    expect(handlers.refreshBalance).toHaveBeenCalledTimes(1);
  });

  it('a failed (cancelled) result is returned for the page to show its notice, not shown as a live reply', async () => {
    const { live, handlers } = fixture();
    const cancelled: AgentTurnOutcome = { state: 'cancelled', unavailable: 'capacity' };
    const result = await runStreamedExecution(live, async () => events([{ type: 'result', result: cancelled }]), ID, handlers);
    expect(result).toEqual(cancelled);
    expect(live.current()).toMatchObject({ phase: 'incomplete' });
    expect(handlers.onResult).toHaveBeenCalledWith(ID, cancelled);
  });

  it('停止 freezes what is shown; later text does not move it', async () => {
    const { live, handlers } = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stopped: AgentTurnOutcome = { state: 'cancelled', stopped: true, completeness: 'stopped' };
    const running = runStreamedExecution(live, async () => events([delta('已显示', 0)], gate,
      [delta('之后', 3), { type: 'result', result: stopped }]), ID, handlers);
    await vi.waitFor(() => expect(live.current()?.text).toBe('已显示'));
    // The stop request keeps exactly what is shown (code points) and where it came from.
    expect(live.stop(ID)).toEqual({ executionId: ID, stopAt: 3, source: 'assistant' });
    expect(live.stop(ID)).toBeNull();
    release();
    await expect(running).resolves.toEqual(stopped);
    expect(live.current()).toMatchObject({ text: '已显示', stopped: true });
    expect(handlers.refreshBalance).toHaveBeenCalledTimes(1);
  });
});

describe('liveReplyText', () => {
  const reply = { executionId: ID, text: '逐字', phase: 'mentor', card: null, rev: 1, points: 2, stalled: false } satisfies LiveReply;
  it('shows the stream for its own open or not yet listed turn', () => {
    expect(liveReplyText(reply, ID)).toBe('逐字');
    expect(liveReplyText(reply, ID, { state: 'running', input: '你好' })).toBe('逐字');
    expect(liveReplyText(reply, 'other', { state: 'running', input: '你好' })).toBeNull();
  });
  it('gives way to the saved reply once the view holds the turn finished', () => {
    expect(liveReplyText(reply, ID, { state: 'completed', input: '你好' })).toBeNull();
    expect(liveReplyText(reply, ID, { state: 'cancelled', input: '你好' })).toBeNull();
  });
  it('never shows protocol output or an empty reply', () => {
    expect(liveReplyText(reply, ID, { state: 'running', input: '[OPC_VIDEO_PACKAGE_V1] …' })).toBeNull();
    expect(liveReplyText({ ...reply, text: '' }, ID)).toBeNull();
    expect(liveReplyText(null, ID)).toBeNull();
  });
});

describe('liveScrollSignature', () => {
  const reply = { executionId: ID, text: '逐', phase: 'mentor', card: null, rev: 1, points: 1, stalled: false } satisfies LiveReply;
  it('changes as streamed text grows or is replaced, so a reader at the bottom keeps following it', () => {
    const grown = liveScrollSignature({ ...reply, text: '逐字', points: 2 });
    expect(grown).not.toBe(liveScrollSignature(reply));
    expect(liveScrollSignature({ ...reply, rev: 2 })).not.toBe(liveScrollSignature(reply));
    expect(liveScrollSignature(null)).toBe('');
  });
});

describe('withResumeStop', () => {
  const resuming = { id: ID + ':payg-resuming', tone: 'status' as const, busy: true, text: '正在继续…' };
  const other = { id: ID + ':payg-outcome', tone: 'warning' as const, text: '其他' };
  it('offers 停止 on the "正在继续…" notice only while this page streams that turn', () => {
    const onClick = vi.fn();
    const [stopped, untouched] = withResumeStop([resuming, other], true, { onClick, disabled: false });
    expect(stopped.actions).toEqual([{ label: '停止', onClick, disabled: false }]);
    expect(untouched).toBe(other);
    stopped.actions![0].onClick();expect(onClick).toHaveBeenCalledOnce();
    expect(withResumeStop([resuming], false, { onClick, disabled: false })[0]).toBe(resuming);
  });
});
