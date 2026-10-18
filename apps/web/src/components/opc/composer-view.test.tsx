/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerTextPreview, ComposerView, ReferenceMenuView, SkillMenuView } from './composer-view';

it('renders the box with its tools, counter, chosen skill and notes', () => {
  const html = renderToStaticMarkup(<ComposerView fileHint="支持 TXT" editor={<i>编辑区</i>} attachment={<b>提问卡</b>} counter={{ length: 19000, max: 20000 }}
    skillName="选题策划" error="附件读取失败，请重试。" note="Enter 发送" status={<p>附件进度</p>} reading sendDisabled/>);
  for (const text of ['<i>编辑区</i>', '<b>提问卡</b>', '19000', '20000', '选题策划', '正在读取附件…', '附件读取失败，请重试。', 'Enter 发送',
    'aria-label="添加资料"', 'aria-label="发送"', '附件进度']) expect(html).toContain(text);
  expect(html).not.toContain('从文件添加');
});

it('opens the file menu and lists skills, or shows their loading state', () => {
  const files = renderToStaticMarkup(<ComposerView menu="files" fileHint="支持 TXT、Markdown。文件会存进你的资料库" editor={null}/>);
  expect(files).toContain('从文件添加');
  expect(files).toContain('支持 TXT、Markdown。文件会存进你的资料库');
  const loading = renderToStaticMarkup(<SkillMenuView query="" skills={[]} hint="" status={<p role="status">正在读取技能…</p>}/>);
  expect(loading).toContain('正在读取技能…');
  expect(loading).not.toContain('没有匹配的可用技能');
  expect(renderToStaticMarkup(<SkillMenuView query="写" skills={[]} hint=""/>)).toContain('没有匹配的可用技能');
});

it('shows the @ picker empty state and reference chips', () => {
  expect(renderToStaticMarkup(<ReferenceMenuView choices={[]} footnote="每条消息最多引用 5 篇文档。"/>)).toContain('没有匹配的已就绪文档');
  const chip = renderToStaticMarkup(<ComposerTextPreview paragraphs={[['看看 ', { reference: '手册.pdf' }]]}/>);
  expect(chip).toContain('看看 <span class="library-reference" data-library-reference="">@手册.pdf</span>');
});

it('shows the placeholder when the preview has no text, and the caret after the last character', () => {
  const empty = renderToStaticMarkup(<ComposerTextPreview paragraphs={[['']]} placeholder="消息"/>);
  expect(empty).toContain('<p class="is-editor-empty" data-placeholder="消息"></p>');
  const typing = renderToStaticMarkup(<ComposerTextPreview paragraphs={[['第一行'], ['第二']]} caret={<i data-caret=""/>}/>);
  expect(typing).toContain('<p>第一行</p><p>第二<i data-caret=""></i></p>');
});
