/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentDraftView } from './content-draft-view';

it('renders the draft column from sample data', () => {
  const html = renderToStaticMarkup(<ContentDraftView platform="小红书" account="烘焙小店" contentLabel="口播稿"
    title="三分钟学会做司康" body="你做的司康总是不起层？" versionLine="账号已保存 v2 · 草稿" saved="已在服务端保存 v2 · 草稿"
    rebaseVersion={3} onErase={() => undefined}><p>分镜区</p></ContentDraftView>);
  for (const text of ['正文稿件', '小红书 · 烘焙小店 · 口播稿', 'value="三分钟学会做司康"', '你做的司康总是不起层？', '账号已保存 v2 · 草稿',
    '已在服务端保存 v2 · 草稿', '基于服务端 v3 保留我的编辑', '展开编辑', '历史版本', '永久删除稿件', '<p>分镜区</p>', '确认定稿口播稿'])
    expect(html).toContain(text);
  expect(html).not.toContain('恢复草稿同步');
});

it('shows only the notice when the source is gone', () => {
  const html = renderToStaticMarkup(<ContentDraftView platform="抖音" account="号" contentLabel="文章" unavailable title="" body=""
    versionLine="" finalizeDisabled><p>分镜区</p></ContentDraftView>);
  expect(html).toContain('来源已不可用，不能编辑或保存这条工作。');
  expect(html).not.toContain('稿件标题');
  expect(html).not.toContain('分镜区');
  expect(html).toContain('确认定稿文章');
});
