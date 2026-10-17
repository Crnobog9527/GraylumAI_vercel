/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerTextPreview, ComposerView, ReferenceMenuView, SkillMenuView } from './composer-view';

it('renders the box with its tools, counter, chosen skill and notes', () => {
  const html = renderToStaticMarkup(<ComposerView editor={<i>编辑区</i>} attachment={<b>提问卡</b>} counter={{ length: 19000, max: 20000 }}
    skillName="选题策划" error="附件读取失败，请重试。" note="Enter 发送" reading sendDisabled/>);
  for (const text of ['<i>编辑区</i>', '<b>提问卡</b>', '19000', '20000', '选题策划', '正在读取附件…', '附件读取失败，请重试。', 'Enter 发送',
    'aria-label="添加资料"', 'aria-label="发送"']) expect(html).toContain(text);
  expect(html).not.toContain('从文件添加');
});

it('opens the file menu and lists skills, or shows their loading state', () => {
  expect(renderToStaticMarkup(<ComposerView menu="files" editor={null}/>)).toContain('从文件添加');
  const loading = renderToStaticMarkup(<SkillMenuView query="" skills={[]} hint="" status={<p role="status">正在读取技能…</p>}/>);
  expect(loading).toContain('正在读取技能…');
  expect(loading).not.toContain('没有匹配的可用技能');
  expect(renderToStaticMarkup(<SkillMenuView query="写" skills={[]} hint=""/>)).toContain('没有匹配的可用技能');
});

it('shows the @ picker empty state and reference chips', () => {
  expect(renderToStaticMarkup(<ReferenceMenuView choices={[]}/>)).toContain('没有匹配的已就绪文档');
  const chip = renderToStaticMarkup(<ComposerTextPreview paragraphs={[['看看 ', { reference: '手册.pdf' }]]}/>);
  expect(chip).toContain('看看 <span class="library-reference" data-library-reference="">@手册.pdf</span>');
});
