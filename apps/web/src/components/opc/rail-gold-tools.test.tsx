/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: unknown; className?: string }) =>
  <a href={href} className={className}>{children as never}</a> }));
vi.mock('@/components/opc/hover-prefetch-link', () => ({ HoverPrefetchLink: ({ href, children }: { href: string; children: unknown }) =>
  <a href={href}>{children as never}</a> }));
vi.mock('@/trpc/client', () => ({ trpc: {} }));
vi.mock('@/components/paywall/ReportPaywallDialog', () => ({ ReportPaywallDialog: () => null }));
vi.mock('@/components/fusion-review/JuryChooser', async () => {
  const actual = await vi.importActual<typeof import('@/components/fusion-review/JuryChooser')>('@/components/fusion-review/JuryChooser');
  return { ...actual, JuryChooser: () => null };
});
vi.mock('@/components/opc/profile-archive/profile-archive-api', () => ({ useProfileBusinesses: () => ({}) }));

import { askCompare, COMPARE_ENTRY_HREF, COMPARE_NEEDS_QUESTION, registerCompareHost } from '@/components/fusion-compare/compare-entry';
import { juryChoices, juryEntryHref } from '@/components/fusion-review/JuryChooser';
import { goldToolEntries } from './rail-gold-tools';
import { RailView } from './rail-view';

const text = (html: string) => html.replace(/<[^>]+>/g, '|');

// Owner 2026-11-12: "多模型对比" moves from beside the message box into the left rail, "评审团" joins it there, and a member whose
// plan lacks a tool may still press its entry and gets the tool's paywall.
describe('the rail\'s entries', () => {
  it('stand with the other tools, after 资料库 and before 发布排期, as buttons anyone can press', () => {
    const html = renderToStaticMarkup(<RailView area="chat" dataReview onCompare={() => {}} onJury={() => {}}><i /></RailView>);
    const order = ['功能广场', '搜索', '资料库', '多模型对比', '评审团', '发布排期', '数据复盘'].map(label => text(html).indexOf(`|${label}|`));
    expect(order.every(at => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const label of ['多模型对比', '评审团']) expect(html).toMatch(new RegExp(`<button type="button">(?:<svg[\\s\\S]*?</svg>)?${label}</button>`));
    expect(html).not.toMatch(/多模型对比[^<]*<\/button>[\s\S]{0,40}disabled|<button[^>]*disabled[^>]*>(?:<svg[\s\S]*?<\/svg>)?(多模型对比|评审团)/);
  });

  it('are absent without a handler: the landing page\'s rail and a tool switched off show none', () => {
    const html = renderToStaticMarkup(<RailView area="chat" dataReview><i /></RailView>);
    expect(html).not.toContain('多模型对比');
    expect(html).not.toContain('评审团');
    expect(renderToStaticMarkup(<RailView area="chat" dataReview onJury={() => {}}><i /></RailView>)).not.toContain('多模型对比');
  });
});

describe('what an entry does, by the server\'s answers', () => {
  it('compare: hidden while unknown or switched off site-wide; the tool for a plan with it; the paywall for any other plan', () => {
    expect(goldToolEntries(undefined, false, null).compare).toBe('hidden');
    expect(goldToolEntries({ enabled: false, reason: 'disabled' }, false, null).compare).toBe('hidden');
    expect(goldToolEntries({ enabled: true }, false, null).compare).toBe('tool');
    expect(goldToolEntries({ enabled: false, reason: 'plan' }, false, null).compare).toBe('paywall');
    expect(goldToolEntries({ enabled: false }, false, null).compare).toBe('paywall');
  });

  it('jury: hidden while switched off or while the plan is not known; then the tool or the paywall, never a guess', () => {
    expect(goldToolEntries(undefined, false, true).jury).toBe('hidden');
    expect(goldToolEntries(undefined, true, null).jury).toBe('hidden');
    expect(goldToolEntries(undefined, true, true).jury).toBe('tool');
    expect(goldToolEntries(undefined, true, false).jury).toBe('paywall');
  });
});

describe('the compare entry and the page with the message box', () => {
  afterEach(() => { registerCompareHost(() => undefined)(); });

  it('asks the page that registered; without one it says so, and the rail opens the new-conversation page', () => {
    expect(askCompare()).toBe(false);
    expect(COMPARE_ENTRY_HREF).toBe('/app/positioning?compare=1');
    const asked = vi.fn();
    const leave = registerCompareHost(asked);
    expect(askCompare()).toBe(true);
    expect(asked).toHaveBeenCalledTimes(1);
    leave();
    expect(askCompare()).toBe(false);
  });

  it('a page that left does not take the next page\'s registration away with it', () => {
    const first = vi.fn(), second = vi.fn();
    const leaveFirst = registerCompareHost(first);
    registerCompareHost(second);
    leaveFirst();
    expect(askCompare()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('keeps the product\'s own words for an empty box', () => {
    expect(COMPARE_NEEDS_QUESTION).toBe('先写好问题再对比');
  });
});

describe('the jury entry\'s list of reports', () => {
  const businesses = [{ name: '美国报税', accounts: [
    { projectId: 'p1', platform: 'xiaohongshu', account: '报税笔记', strategyDraftId: 'd1' },
    { projectId: 'p2', platform: 'douyin', account: '报税短视频', strategyDraftId: 'd2' },
    { projectId: 'p3', platform: 'x', account: '还没定位', strategyDraftId: null },
    { projectId: 'p4', platform: 'xiaohongshu', account: '同一份定位的第二个账号', strategyDraftId: 'd1' }] }];
  const drafts = [{ draftId: 'd1', state: 'published', currentVersion: 2 }, { draftId: 'd2', state: 'draft', currentVersion: 0 }];

  it('lists each confirmed positioning once, by its account and platform name, and leaves out what is not confirmed', () => {
    const choices = juryChoices(businesses, drafts, []);
    expect(choices.map(choice => choice.draftId)).toEqual(['d1']);
    expect(choices[0]).toMatchObject({ name: '小红书 · 报税笔记', business: '美国报税' });
    expect(juryEntryHref('d1')).toBe('/app/positioning/d1?jury=1');
  });

  it('carries a positioning\'s newest review, and is empty while nothing is confirmed or read', () => {
    const reviews = [{ draftId: 'd1', reviewId: 'r2', state: 'running', awaitingChoice: false }, { draftId: 'd1', reviewId: 'r1', state: 'completed', awaitingChoice: false }];
    expect(juryChoices(businesses, drafts, reviews as never)[0]?.review?.reviewId).toBe('r2');
    expect(juryChoices(businesses, [{ draftId: 'd1', state: 'draft', currentVersion: 0 }], [])).toEqual([]);
    expect(juryChoices(undefined, undefined, undefined)).toEqual([]);
  });
});

// Seven entries stand above the conversation list now. Measured locally on 2026-11-12: at a 650px-high window the list had 0px.
it('a short desktop window: the rail scrolls as a whole and the list keeps 120px, as the phone drawer does', () => {
  const css = readFileSync(fileURLToPath(new URL('./workspace-frame.module.css', import.meta.url)), 'utf8');
  expect(css).toContain('@media(min-width:701px) and (max-height:780px){.rail{overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}.rail .history{min-height:120px}}');
});
