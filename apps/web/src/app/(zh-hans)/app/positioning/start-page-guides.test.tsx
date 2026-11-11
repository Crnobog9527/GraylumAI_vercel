/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  businesses: { isPending: false, error: null as unknown, businesses: [] as unknown[] | undefined },
  drafts: [] as Array<{ draftId: string; createdAt: string }>,
}));
vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: unknown; className?: string }) =>
  <a href={href} className={className}>{children as never}</a> }));
vi.mock('@/trpc/client', () => ({ trpc: { opc: { list: { useQuery: () => ({ data: { drafts: state.drafts } }) } } } }));
vi.mock('@/components/opc/profile-archive/profile-archive-api', () => ({ useProfileBusinesses: () => state.businesses }));

import { StrategyCards } from './strategy-cards';
import { TopicsEmpty } from './topics-empty';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const noop = () => undefined;

// Owner 2026-11-12 (MASTER_PLAN §2.1): no onboarding dialog; a user without a confirmed positioning sees the positioning card first, marked.
describe('StrategyCards', () => {
  it('without a confirmed positioning: 找到你的内容定位 comes first and says 从这里开始', () => {
    const html = renderToStaticMarkup(<StrategyCards startHere onTopics={noop} onPosition={noop} />);
    expect(html.indexOf('找到你的内容定位')).toBeLessThan(html.indexOf('做一批新选题'));
    expect(text(html)).toContain('从这里开始');
  });

  it('with one: the usual order and no mark', () => {
    const html = renderToStaticMarkup(<StrategyCards startHere={false} onTopics={noop} onPosition={noop} />);
    expect(html.indexOf('做一批新选题')).toBeLessThan(html.indexOf('找到你的内容定位'));
    expect(text(html)).not.toContain('从这里开始');
  });
});

// Walkthrough 2026-11-11, item 4: "还没有可用于选题的已确认策略账号。请先梳理定位。" with no way on.
describe('TopicsEmpty', () => {
  beforeEach(() => { state.businesses = { isPending: false, error: null, businesses: [] }; state.drafts = []; });

  it('says what is missing in plain words and leads back into the positioning that exists', () => {
    state.businesses.businesses = [{ businessId: 'b1', name: '报税 · 小红书', isArchived: false, drafts: [{ draftId: 'd-old' }, { draftId: 'd-new' }] }];
    state.drafts = [{ draftId: 'd-old', createdAt: '2026-11-01' }, { draftId: 'd-new', createdAt: '2026-11-10' }];
    const html = renderToStaticMarkup(<TopicsEmpty onStart={noop} />);
    expect(text(html)).toContain('选题要等定位三步都确认后才能做。');
    expect(html).toMatch(/<a href="\/app\/positioning\/d-new"[^>]*>继续定位<\/a>/);
    expect(text(html)).not.toMatch(/策略账号|开始定位/);
  });

  it('with no positioning at all, offers to start one', () => {
    const html = renderToStaticMarkup(<TopicsEmpty onStart={noop} />);
    expect(html).toMatch(/<button type="button"[^>]*>开始定位<\/button>/);
    expect(text(html)).not.toContain('继续定位');
  });

  it('an archived profile is not something to continue', () => {
    state.businesses.businesses = [{ businessId: 'b1', isArchived: true, archivedAt: '2026-11-05', drafts: [{ draftId: 'd1' }] }];
    expect(text(renderToStaticMarkup(<TopicsEmpty onStart={noop} />))).toContain('开始定位');
  });

  it('while the profiles are not known yet, or could not be read, it offers no button that might be the wrong one', () => {
    for (const unknown of [{ isPending: true, error: null, businesses: undefined }, { isPending: false, error: new Error('x'), businesses: undefined }]) {
      state.businesses = unknown;
      const html = renderToStaticMarkup(<TopicsEmpty onStart={noop} />);
      expect(text(html)).toContain('选题要等定位三步都确认后才能做。');
      expect(html).not.toMatch(/<a |<button/);
    }
  });
});

describe('the start page itself', () => {
  const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');

  it('no longer shows the developer note or the old jargon (walkthrough items 4 and 9)', () => {
    expect(page).not.toContain('运行环境和模型模式');
    expect(page).not.toContain('策略账号');
  });

  it('sends a signed-in user to the membership page, not the public pricing page, from the one place the limit is shown (item 11)', () => {
    expect(page).not.toContain('href="/pricing"');
    expect(page.match(/href="\/app\/profile\?tab=subscription">查看会员方案 →/g)).toHaveLength(1);
    expect(page.match(/<ProfileArchiveList limitReached\/>/g)).toHaveLength(1);
  });

  it('"unknown" is not "no positioning": the mark and the notice wait for both reads', () => {
    expect(page).toContain('const noPositioning=library.isSuccess&&list.isSuccess&&!library.error&&!list.error&&!topicAccounts.length;');
    expect(page).toContain('<StrategyCards startHere={noPositioning}');
  });

  it('the two shortcuts above the box follow the rail\'s switch, like the cards below', () => {
    expect(page).toContain('const toolsOpen=publishTools.data?.ownData===true;');
    expect(page).toContain('{toolsOpen?<><Link prefetch={false} href="/app/publish-monitor">');
    expect(page).toContain('<OperationsCards open={toolsOpen}/>');
  });
});
