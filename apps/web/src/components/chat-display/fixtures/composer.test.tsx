/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerTextPreview, ComposerView, ReferenceMenuView, SkillMenuView } from '@/components/opc/composer-view';
import * as C from './composer';
import * as L from './library';

// The landing page renders the shared fixtures like this: they must stay renderable without any query.
it('renders the message box with referenced documents and the open @ picker', () => {
  const html = renderToStaticMarkup(<ComposerView note={C.SAMPLE_COMPOSER_NOTE} fileHint={C.SAMPLE_FILE_HINT}
    editor={<ComposerTextPreview paragraphs={C.SAMPLE_COMPOSER_REFERENCED_TEXT}/>}
    referenceMenu={<ReferenceMenuView choices={C.SAMPLE_REFERENCE_CHOICES} highlighted={C.SAMPLE_REFERENCE_HIGHLIGHTED}
      footnote={C.SAMPLE_REFERENCE_FOOTNOTE}/>}/>);
  expect(html).toContain('class="library-reference"');
  for (const text of ['@品牌介绍.pdf', '@去年爆款笔记.md', '帮我写这周的选题', '引用资料库文档', 'aria-selected="true"', C.SAMPLE_REFERENCE_FOOTNOTE, 'Auto',
    C.SAMPLE_COMPOSER_NOTE]) expect(html).toContain(text);
});

it('lists only ready text documents in the @ picker, like the product', () => {
  const ready = L.SAMPLE_LIBRARY_DOCUMENTS.filter(item => item.kind === 'document' && item.status === 'ready').map(item => item.filename);
  expect(C.SAMPLE_REFERENCE_CHOICES.map(item => item.label)).toEqual(ready);
  expect(C.SAMPLE_REFERENCE_CHOICES.length).toBeGreaterThan(0);
  const html = renderToStaticMarkup(<ReferenceMenuView choices={C.SAMPLE_REFERENCE_CHOICES} footnote={C.SAMPLE_REFERENCE_FOOTNOTE}/>);
  for (const item of L.SAMPLE_LIBRARY_DOCUMENTS.filter(doc => doc.kind !== 'document' || doc.status !== 'ready'))
    expect(html).not.toContain(item.filename ?? '');
});

it('renders the file menu and the skill menu from the shared fixtures', () => {
  const files = renderToStaticMarkup(<ComposerView menu="files" fileHint={C.SAMPLE_FILE_HINT} editor={null}/>);
  expect(files).toContain(C.SAMPLE_FILE_HINT);
  const html = renderToStaticMarkup(<ComposerView menu="skills" skillName="选题策划" fileHint={C.SAMPLE_FILE_HINT}
    editor={<ComposerTextPreview paragraphs={C.SAMPLE_COMPOSER_PLAIN_TEXT}/>}
    skillMenu={<SkillMenuView query="" skills={C.SAMPLE_SKILLS} hint={C.SAMPLE_SKILL_HINT}/>}/>);
  for (const text of ['使用技能', '选题策划', '口播稿写作', C.SAMPLE_SKILL_HINT, '浏览功能广场', '我是做烘焙的']) expect(html).toContain(text);
});
