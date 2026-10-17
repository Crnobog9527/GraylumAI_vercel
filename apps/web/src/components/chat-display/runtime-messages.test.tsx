/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RuntimeEmptyState, RuntimeHeader, RuntimePendingMessage, RuntimeProposal, RuntimeReply, RuntimeResultsSection, RuntimeTurnView,
  RuntimeTypePendingPanel,
} from './runtime-messages';

const versions = [
  { id: 'script-1', kind: 'script', version: 1, status: 'final', body: '口播稿正文', sourceContentId: null },
  { id: 'board-1', kind: 'storyboard', version: 1, status: 'draft', body: '镜头 1：开箱', sourceContentId: 'script-1' },
  { id: 'edit-1', kind: 'editing', version: 2, status: 'final', body: '节奏放慢', sourceContentId: 'script-0' },
];

it('renders a work conversation from sample data', () => {
  const html = renderToStaticMarkup(<>
    <RuntimeHeader title="三分钟学会做司康" meta={{ platform: '小红书', account: '烘焙小店', infoHref: '/library', showExpand: true }}/>
    <RuntimeTurnView dateLabel="今天 10:30" userText="帮我想一版开头" completed>
      <RuntimeProposal adopted={false} text="**开头**：你做的司康总是不起层？"/>
    </RuntimeTurnView>
    <RuntimeTurnView userText="再短一点"><RuntimeReply text="好的，缩短到 15 秒。"/></RuntimeTurnView>
    <RuntimeTurnView><RuntimeReply available={false} text="不会显示"/></RuntimeTurnView>
    <RuntimePendingMessage text="就用这一版" sending/>
  </>);
  for (const text of ['三分钟学会做司康', '小红书 · 烘焙小店', '工作信息', '展开成果', '今天 10:30', '帮我想一版开头', '已完成本轮建议',
    '建议稿', '尚未采用', '<strong>开头</strong>', '缩短到 15 秒', '来源已不可用，暂不展示此内容。', '就用这一版']) expect(html).toContain(text);
  expect(html).not.toContain('不会显示');
});

it('renders the header action and the empty state without a topic', () => {
  const html = renderToStaticMarkup(<>
    <RuntimeHeader title="工作对话" subtitle="本地模拟体验" action={<button type="button">用此功能准备新任务</button>}/>
    <RuntimeEmptyState text="从左侧“新对话”开始。"/>
  </>);
  for (const text of ['工作对话', '本地模拟体验', '用此功能准备新任务', '开始一段对话', '从左侧“新对话”开始。']) expect(html).toContain(text);
});

it('renders the storyboard column and saved Skill results', () => {
  const html = renderToStaticMarkup(<>
    <RuntimeTypePendingPanel/>
    <RuntimeResultsSection isVideo versions={versions} currentScriptId="script-1" libraryHref="/library?item=w1"
      saved={[{ artifactId: 'a1', version: 3, body: null }]}/>
  </>);
  for (const text of ['当前成果', '分镜与剪辑建议', '分镜 · 第 1 版 · 草稿', ' · 匹配当前口播稿', '镜头 1：开箱', '剪辑建议 · 第 2 版 · 已定稿',
    ' · 旧口播稿版本', '其他 Skill 成果 · 第 3 版', '来源不可用', '在资料库查看这个选题']) expect(html).toContain(text);
  expect(html).not.toContain('口播稿正文');
});

it('shows nothing for a non-video topic without saved results', () => {
  expect(renderToStaticMarkup(<RuntimeResultsSection isVideo={false} versions={versions} libraryHref="/library" saved={[]}/>)).toBe('');
});

it('keeps the header title an h1 by default and renders it at the level a page asks for, styled the same', async () => {
  expect(renderToStaticMarkup(<RuntimeHeader title="工作对话"/>)).toContain('<h1>工作对话</h1>');
  const nested = renderToStaticMarkup(<RuntimeHeader title="工作对话" headingLevel="h2"/>);
  expect(nested).toContain('<h2>工作对话</h2>');
  expect(nested).not.toContain('<h1');
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../app/runtime/runtime-work.module.css', import.meta.url), 'utf8');
  expect(css).toContain('.workTitle :is(h1,h2){');
});
