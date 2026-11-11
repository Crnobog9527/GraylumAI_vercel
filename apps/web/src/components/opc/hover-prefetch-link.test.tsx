/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as R from '../chat-display/fixtures/rail';

/**
 * SITE-SPEED: which links of the signed-in shell fetch their page ahead while pointed at, and which never do.
 *
 * #1392 (DB-100) turned the fetching ahead off for every signed-in link, because every link on screen was fetched on each
 * page load. Only the rail's fixed entries get it back, and only while pointed at (HoverPrefetchLink). The rows of the
 * lists (conversations, work threads, drafts, the positioning row), the top bar and the announcement stay as #1392 left
 * them. A row turned into a HoverPrefetchLink, or a link that loses `prefetch={false}`, fails here.
 *
 * next/link is replaced by an anchor that writes down what it was given: `data-prefetch` (the prop) and `data-ahead`
 * (whether it carries the pointer handlers HoverPrefetchLink adds). What a pointer then does is the browser test's.
 */
vi.mock('next/link', () => ({
  default: ({ href, prefetch, onMouseEnter, children }: { href: string; prefetch?: boolean | null; onMouseEnter?: unknown; children?: ReactNode }) =>
    <a href={href} data-prefetch={String(prefetch)} data-ahead={typeof onMouseEnter === 'function' ? 'yes' : 'no'}>{children}</a>,
}));

const { ConversationRow } = await import('./conversation-row');
const { DraftRow } = await import('./draft-row');
const { AnnouncementBar, GlobalHeader, RailAccount, RailGroup, RailHistory, RailStrategyRow, RailView, RailWorkThread } = await import('./rail-view');

const menuPosition = { top: 10, left: 20 };
const RETURN = '?returnTo=%2Fapp';

function shell(dataReview: boolean) {
  return renderToStaticMarkup(<>
    <GlobalHeader area="chat"/>
    <AnnouncementBar returnParam={RETURN}/>
    <RailView area="chat" returnParam={RETURN} dataReview={dataReview}>
      <RailHistory archiveView={false}>
        {R.SAMPLE_RAIL_PLATFORMS.map(({ platform, accounts }) => <RailGroup key={platform} title={platform} open>
          {accounts.map(account => <RailAccount key={account.projectId} name={account.name} open renaming={false} renameValue={account.name}>
            {account.strategy && <RailStrategyRow draftId={account.strategy.draftId} accountName={account.name} confirmed={account.strategy.confirmed}
              statusLabel={account.strategy.statusLabel} menuOpen menuPosition={menuPosition}/>}
            {account.threads.map(thread => <RailWorkThread key={thread.sessionId} sessionId={thread.sessionId} name={thread.name} dateLabel={thread.dateLabel}
              active={false} renaming={false} renameValue="" menuOpen={false} menuPosition={menuPosition} archiveView={false} confirming={false}/>)}
          </RailAccount>)}
        </RailGroup>)}
        <RailGroup title="对话" open>
          <ConversationRow conversation={R.SAMPLE_RAIL_CONVERSATION} menuOpen={false} menuPosition={menuPosition} onOpenMenu={() => undefined}
            onCloseMenu={() => undefined} onDelete={() => undefined} rename={R.SAMPLE_RAIL_RENAME}/>
        </RailGroup>
        <RailGroup title="待归类" open>
          <DraftRow draft={R.SAMPLE_RAIL_UNASSIGNED_DRAFT} menuOpen={false} menuPosition={menuPosition} onOpenMenu={() => undefined}
            onCloseMenu={() => undefined} onDeleteConversation={() => undefined} onDeleteDraft={() => undefined}/>
        </RailGroup>
      </RailHistory>
    </RailView>
  </>);
}

type Anchor = { href: string; prefetch: string; ahead: boolean };
function anchors(html: string): Anchor[] {
  return [...html.matchAll(/<a href="([^"]*)" data-prefetch="([^"]*)" data-ahead="(yes|no)"/g)]
    .map(([, href, prefetch, ahead]) => ({ href: href.replaceAll('&amp;', '&'), prefetch, ahead: ahead === 'yes' }));
}

const FIXED = ['/app/positioning', '/app/workbench/marketplace' + RETURN, '/app/workbench/search' + RETURN, '/app/library' + RETURN];
const SWITCHED_ON = ['/app/publish-schedule' + RETURN, '/app/publish-monitor' + RETURN];

it('only the fixed entries of the rail fetch ahead while pointed at: four of them, six once 发布排期 and 数据复盘 are links', () => {
  expect(anchors(shell(false)).filter(a => a.ahead).map(a => a.href)).toEqual(FIXED);
  expect(anchors(shell(true)).filter(a => a.ahead).map(a => a.href)).toEqual([...FIXED, ...SWITCHED_ON]);
});

it('the top bar, the announcement and every row of the lists stay links that fetch on the click', () => {
  const rest = anchors(shell(true)).filter(a => !a.ahead).map(a => a.href);
  // Top bar (logo, 首页, 对话, 个人中心), the announcement's link, then the rows: the positioning row and its menu entry,
  // the work threads, a free conversation and an unassigned draft.
  expect(rest.slice(0, 5)).toEqual(['/app', '/app', '/app/positioning', '/app/profile', '/app/workbench/marketplace' + RETURN]);
  const rows = rest.slice(5);
  expect(rows.filter(href => href.startsWith('/app/runtime?session=')).length).toBeGreaterThanOrEqual(3);
  expect(rows.filter(href => href.startsWith('/app/positioning/')).length).toBeGreaterThanOrEqual(2);
  expect(rows.every(href => href.startsWith('/app/runtime?session=') || href.startsWith('/app/positioning/'))).toBe(true);
});

it('at rest nothing is fetched ahead: every link of the shell is given prefetch={false}', () => {
  const all = anchors(shell(true));
  expect(all.length).toBeGreaterThanOrEqual(16);
  expect(all.filter(a => a.prefetch !== 'false')).toEqual([]);
});
