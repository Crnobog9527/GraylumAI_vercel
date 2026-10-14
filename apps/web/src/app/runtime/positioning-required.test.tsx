/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatNoticeList, type ChatNotice } from '@/components/chat/ChatInlineNotice';
import { readStartEntry } from '@/app/positioning/start-entry';
import { POSITIONING_REQUIRED_NOTICE, runtimeAdmissionNotice, runtimeExecutionNotice } from './gate-notices';
import { POSITIONING_ACTIONS, POSITIONING_CARD_LABEL, positioningEntryHref } from './positioning-required';
import { ENDED_NOTICE, runtimeTailNotices, runtimeTurnNotices, type RuntimeTurn } from './runtime-notices';

// POSITIONING-GATE step 3: one guide card (start / import), the same wherever the refusal surfaces.
const server = 'POSITIONING_REQUIRED：为自己的账号做社媒运营之前，需要先完成定位，或者导入你已有的定位。本次没有扣积分。';
const refusal = Object.assign(new Error(server), { data: { code: 'PRECONDITION_FAILED', path: 'runtime.prepare' } });
const turn = (extra: Partial<RuntimeTurn> = {}): RuntimeTurn => ({ executionId: 'e1', state: 'cancelled', primaryBody: null,
  organizerComplete: null, needsTask: false, unavailableReason: 'positioning_required', ...extra });
const ctx = (navigate: (href: string) => void) =>
  ({ busy: false, capacity: false, stopping: false, onRetry: vi.fn(), onStop: vi.fn(), navigate });
const tail = (error: string, navigate: (href: string) => void, lastTurn?: { open: boolean; texts: readonly string[] }) =>
  runtimeTailNotices({ error, heldGuide: false, busy: false, onGuide: vi.fn(), navigate, lastTurn });
const html = (notices: ChatNotice[]) => renderToStaticMarkup(createElement(ChatNoticeList, { notices }));

describe('positioning guide card', () => {
  it('renders the explanation, the not-charged note and both entries, without any code', () => {
    const markup = html(tail(runtimeAdmissionNotice(refusal)!, vi.fn()));
    expect(markup).toContain(`aria-label="${POSITIONING_CARD_LABEL}"`);
    expect(markup).toContain('本次没有扣积分');
    expect(markup).toContain('>开始定位</button>');
    expect(markup).toContain('>导入已有定位</button>');
    expect(markup).not.toContain('POSITIONING_REQUIRED');
  });

  it('is the same card for an admission refusal, a refused execution and a refreshed turn', () => {
    const fromAdmission = tail(runtimeAdmissionNotice(refusal)!, vi.fn());
    const fromExecution = tail(runtimeExecutionNotice({ state: 'cancelled', unavailable: 'positioning_required' })!, vi.fn());
    const fromTurn = runtimeTurnNotices(turn(), ctx(vi.fn()));
    const shape = (n: ChatNotice[]) => n.map(({ tone, text, label, actions }) => ({ tone, text, label, actions: actions?.map(a => a.label) }));
    expect(shape(fromAdmission)).toEqual(shape(fromExecution));
    expect(shape(fromTurn)).toEqual(shape(fromAdmission));
    expect(fromTurn[0]!.text).toBe(POSITIONING_REQUIRED_NOTICE);
    expect(fromTurn[0]!.text).not.toBe(ENDED_NOTICE);
  });

  it('shows one card when the refreshed turn already carries it', () => {
    const notices = tail(POSITIONING_REQUIRED_NOTICE, vi.fn(), { open: false, texts: [POSITIONING_REQUIRED_NOTICE] });
    expect(notices).toEqual([]);
  });

  it('opens the one-click start and import entries, each with its own start request', () => {
    const navigate = vi.fn();
    const [card] = runtimeTurnNotices(turn(), ctx(navigate));
    const [start, existing] = card!.actions!;
    expect([start!.label, existing!.label]).toEqual([POSITIONING_ACTIONS.mentor, POSITIONING_ACTIONS.manual]);
    start!.onClick(); existing!.onClick(); start!.onClick();
    const entries = navigate.mock.calls.map(([href]) => { const url = new URL(href, 'https://x'); return { path: url.pathname, ...readStartEntry(url.search) }; });
    expect(entries.map(e => [e.path, e.mode])).toEqual([['/positioning', 'mentor'], ['/positioning', 'manual'], ['/positioning', 'mentor']]);
    expect(entries.every(e => e.intent)).toBe(true);
    expect(new Set(entries.map(e => e.intent)).size).toBe(3);
  });

  it('keeps other notices unchanged', () => {
    expect(tail('请求状态待核实。', vi.fn())).toEqual([{ id: 'error', tone: 'error', text: '请求状态待核实。' }]);
    expect(positioningEntryHref('manual', '11111111-1111-4111-8111-111111111111'))
      .toBe('/positioning?start=manual&intent=11111111-1111-4111-8111-111111111111');
  });
});
