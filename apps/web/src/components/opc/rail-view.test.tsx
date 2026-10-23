/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationRow } from './conversation-row';
import { DraftRow } from './draft-row';
import {
  AnnouncementBar, GlobalHeader, RailAccount, RailBottom, RailEmpty, RailGroup, RailHistory, RailNotices, RailOlder, RailStrategyRow, RailView,
  RailWorkThread,
} from './rail-view';
import * as R from '../chat-display/fixtures/rail';

const menuPosition = { top: 10, left: 20 };

// The landing page renders the whole rail from the shared fixtures; no query, no sign-in.
it('renders the whole rail from the shared fixtures', () => {
  const html = renderToStaticMarkup(<>
    <GlobalHeader area={R.SAMPLE_RAIL_AREA}/>
    <AnnouncementBar notice={R.SAMPLE_ANNOUNCEMENT_NOTICE}/>
    <RailView area={R.SAMPLE_RAIL_AREA}>
      <RailHistory archiveView={false}>
        {R.SAMPLE_RAIL_PLATFORMS.map(({ platform, accounts }) => <RailGroup key={platform} title={platform} open>
          {accounts.map(account => <RailAccount key={account.projectId} name={account.name} open renaming={account.projectId === R.SAMPLE_RAIL_RENAMING_ACCOUNT}
            renameValue={account.name}>
            {account.strategy
              ? <RailStrategyRow draftId={account.strategy.draftId} accountName={account.name} confirmed={account.strategy.confirmed}
                statusLabel={account.strategy.statusLabel} menuOpen={false} menuPosition={menuPosition}/>
              : <RailEmpty>定位策略待建立</RailEmpty>}
            {account.threads.map(thread => <RailWorkThread key={thread.sessionId} sessionId={thread.sessionId} name={thread.name} pinned={thread.pinned}
              dateLabel={thread.dateLabel} active={thread.sessionId === 'sample-session-1'} renaming={false} renameValue="" menuOpen={false}
              menuPosition={menuPosition} archiveView={false} confirming={false}/>)}
            {account.threads.length > 1 && <RailOlder count={3}/>}
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
      <RailNotices items={[]}/>
      <RailBottom {...R.SAMPLE_RAIL_BOTTOM} creditsOpen={false} profileOpen={false}/>
    </RailView>
  </>);
  for (const text of ['全局导航', '让好想法，继续向前。', '新对话', '功能广场', '搜索', '资料库', '发布排期', '数据复盘', '待接入', '平台 · 账号 · 工作', '小红书',
    '烘焙小店', '定位策略', '当前 v2', '进行中 · 手作蛋糕日记', '重命名账号', '保存账号名称', '三分钟学会做司康', '已置顶', '周末市集的开场口播', '查看更早 3 项',
    '定位策略待建立', '想做一个美食账号，从哪开始？', '新店 · 定位分析', '在线反馈', '积分', '1200', '专业会员']) expect(html).toContain(text);
});

it('opens the row menus, with the confirm step and the archive view', () => {
  const thread = (extra: object) => renderToStaticMarkup(<RailWorkThread sessionId="s" name="某对话" dateLabel="2026/10/1" active={false} renaming={false}
    renameValue="" menuOpen menuPosition={menuPosition} archiveView={false} confirming={false} {...extra}/>);
  const normal = thread({});
  for (const text of ['重命名', '置顶', '归档', '从列表移除', '永久删除对话记录', '永久删除稿件与成果']) expect(normal).toContain(text);
  expect(thread({ pinned: true })).toContain('取消置顶');
  expect(thread({ confirming: true })).toContain('确认从列表移除（内容不删除）');
  const archived = thread({ archiveView: true });
  expect(archived).toContain('恢复归档');
  expect(archived).not.toContain('>归档<');
  const strategy = renderToStaticMarkup(<RailStrategyRow draftId="d" accountName="号" confirmed statusLabel="已确认" menuOpen menuPosition={menuPosition} opening/>);
  for (const text of ['查看或修改定位', '正在打开…']) expect(strategy).toContain(text);
});

it('shows the archive heading and the notices', () => {
  const html = renderToStaticMarkup(<>
    <RailHistory archiveView><p>x</p></RailHistory>
    <RailNotices items={[{ text: '名字没有保存', role: 'alert' }, { text: '已删除', role: 'status' }]}/>
  </>);
  for (const text of ['归档记录', '返回最近工作', '名字没有保存', 'role="status"', '已删除']) expect(html).toContain(text);
});

it('keeps 发布排期 and 数据复盘 unavailable by default and shows them available when the page draws the product as launched', () => {
  const product = renderToStaticMarkup(<RailView area="chat"><span/></RailView>);
  expect(product.match(/<button disabled="">/g)).toHaveLength(2);
  expect(product.match(/<small>待接入<\/small>/g)).toHaveLength(2);
  const launched = renderToStaticMarkup(<RailView area="chat" launched><span/></RailView>);
  expect(launched).not.toContain('待接入');
  expect(launched).not.toContain('disabled');
  // Not controls with nothing behind them: plain links without a target, so neither focusable nor clickable.
  expect(launched).not.toMatch(/<button[^>]*>[^<]*<img[^>]*calendar-blank/);
  expect(launched).toMatch(/<a><img[^>]*calendar-blank[^>]*\/>发布排期<\/a>/);
  for (const name of ['发布排期', '数据复盘']) expect(launched).toContain(name);
});

it('links 数据复盘 to the data review page once its switch is on, leaving 发布排期 unavailable', () => {
  const html = renderToStaticMarkup(<RailView area="review" returnParam="?returnTo=%2Fapp" dataReview><span/></RailView>);
  expect(html).toMatch(/<a aria-current="page" href="\/app\/publish-monitor\?returnTo=%2Fapp"><img[^>]*chart-bar[^>]*\/>数据复盘<\/a>/);
  expect(html.match(/<small>待接入<\/small>/g)).toHaveLength(1);
});
