/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerTextPreview, ComposerView, ReferenceMenuView, SkillMenuView } from '@/components/opc/composer-view';
import { DocumentList, SpacePanel, UploadPanel } from '@/components/library/my-documents-view';
import * as C from './composer';
import * as L from './library';

const noop = () => undefined;

// The landing page renders the shared fixtures like this: they must stay renderable without any query.
it('renders the message box with referenced documents and the open @ picker', () => {
  const html = renderToStaticMarkup(<ComposerView note={C.SAMPLE_COMPOSER_NOTE}
    editor={<ComposerTextPreview paragraphs={C.SAMPLE_COMPOSER_REFERENCED_TEXT}/>}
    referenceMenu={<ReferenceMenuView choices={C.SAMPLE_REFERENCE_CHOICES} highlighted={C.SAMPLE_REFERENCE_HIGHLIGHTED}/>}/>);
  expect(html).toContain('class="library-reference"');
  for (const text of ['@品牌介绍.pdf', '@去年爆款笔记.md', '帮我写这周的选题', '引用资料库文档', '客户常见问题.docx', 'aria-selected="true"',
    '引用尚未开放', 'Auto', C.SAMPLE_COMPOSER_NOTE]) expect(html).toContain(text);
});

it('renders the skill menu from the shared fixtures', () => {
  const html = renderToStaticMarkup(<ComposerView menu="skills" skillName="选题策划"
    editor={<ComposerTextPreview paragraphs={C.SAMPLE_COMPOSER_PLAIN_TEXT}/>}
    skillMenu={<SkillMenuView query="" skills={C.SAMPLE_SKILLS} hint={C.SAMPLE_SKILL_HINT}/>}/>);
  for (const text of ['使用技能', '选题策划', '口播稿写作', C.SAMPLE_SKILL_HINT, '浏览功能广场', '我是做烘焙的']) expect(html).toContain(text);
});

it('renders the library page parts from the shared fixtures', () => {
  const html = renderToStaticMarkup(<>
    <UploadPanel uploadEnabled spaceKnown {...L.SAMPLE_LIBRARY_SPACE} uploads={L.SAMPLE_LIBRARY_UPLOADS}
      onAdd={noop} onRetry={noop} onDismiss={noop}/>
    <SpacePanel {...L.SAMPLE_LIBRARY_SPACE}/>
    <DocumentList documents={L.SAMPLE_LIBRARY_DOCUMENTS} ready onOpen={noop} onDownload={noop} onDelete={noop} onPurpose={noop}/>
  </>);
  for (const text of ['品牌介绍.pdf', '可用', '处理中', '上传失败', '店铺门头.png', '预览', '新品介绍.pdf', '上传中 42%', '空间使用'])
    expect(html).toContain(text);
});
