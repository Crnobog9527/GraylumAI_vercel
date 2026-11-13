/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));
import { SignupGuardSummary, type SignupGuardView } from './SignupGuardCard';
import { draftFrom, needsPauseConfirm, parseSignupGuardDraft } from './signupGuardDraft';

const settings = { dailyCap: 30, ipLimit: 5, paused: false };
const view = (over: Partial<SignupGuardView> = {}): SignupGuardView => ({
  day: '2026-11-13', granted: 12, settings,
  refused: { paused: { today: 0, last7Days: 2 }, sameIp: { today: 3, last7Days: 7 }, dailyCap: { today: 1, last7Days: 10 } },
  ...over,
});

describe('SignupGuardSummary', () => {
  it("shows today's count against the cap and the refusals by reason, today and over 7 days", () => {
    const html = renderToStaticMarkup(createElement(SignupGuardSummary, { view: view() }));
    expect(html).toContain('已送 12 / 上限 30');
    for (const cell of ['暂停中</td><td class="py-1">0</td><td class="py-1">2', '同一网络超过上限</td><td class="py-1">3</td><td class="py-1">7',
      '当天送完了</td><td class="py-1">1</td><td class="py-1">10']) expect(html).toContain(cell);
    expect(html).toContain('可能误伤');
  });

  it('says when nobody new is granted, and drops the misfire hint when no network was refused today', () => {
    const paused = renderToStaticMarkup(createElement(SignupGuardSummary, { view: view({ settings: { ...settings, paused: true } }) }));
    expect(paused).toContain('注册赠送已暂停');
    const zero = view({ settings: { ...settings, dailyCap: 0 } });
    zero.refused = { ...zero.refused, sameIp: { today: 0, last7Days: 0 } };
    const html = renderToStaticMarkup(createElement(SignupGuardSummary, { view: zero }));
    expect(html).toContain('上限为 0');
    expect(html).not.toContain('可能误伤');
  });
});

describe('the card form', () => {
  it('saves whole numbers in range and never reads an empty box as 0', () => {
    expect(parseSignupGuardDraft(draftFrom(settings))).toEqual({ ok: true, value: settings });
    expect(parseSignupGuardDraft({ dailyCap: ' 0 ', ipLimit: '50', paused: true })).toEqual({ ok: true, value: { dailyCap: 0, ipLimit: 50, paused: true } });
    for (const [dailyCap, ipLimit] of [['', '5'], ['100001', '5'], ['-1', '5'], ['2.5', '5'], ['30', ''], ['30', '0'], ['30', '51'], ['30', 'abc']]) {
      expect(parseSignupGuardDraft({ dailyCap, ipLimit, paused: false }), `${dailyCap}/${ipLimit}`).toMatchObject({ ok: false });
    }
  });

  it('asks before turning the pause on, not when it stays or goes off', () => {
    expect(needsPauseConfirm(settings, { ...settings, paused: true })).toBe(true);
    expect(needsPauseConfirm({ ...settings, paused: true }, { ...settings, paused: true })).toBe(false);
    expect(needsPauseConfirm({ ...settings, paused: true }, settings)).toBe(false);
  });
});
