/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SAMPLE_LIBRARY_DOCUMENTS } from './library';
import type { ComposerPreviewParagraph, ReferenceChoice, SkillChoice } from '@/components/opc/composer-view';

/**
 * Sample data for the message box display components (`@/components/opc/composer-view`), shared by
 * the landing page and the component tests. Made-up example content only.
 */

/** A message that already references two library documents ("已引用" state). */
export const SAMPLE_COMPOSER_REFERENCED_TEXT: ComposerPreviewParagraph[] = [
  ['参考 ', { reference: '品牌介绍.pdf' }, ' 和 ', { reference: '去年爆款笔记.md' }, ' 帮我写这周的选题'],
];

export const SAMPLE_COMPOSER_PLAIN_TEXT: ComposerPreviewParagraph[] = [['我是做烘焙的，想在小红书接定制蛋糕的单。']];

/**
 * The `@` picker lists ready text documents of the library, the same rule as the product (`matchingDocuments`):
 * the processing document, the failed one and the image in the library sample are left out.
 */
export const SAMPLE_REFERENCE_CHOICES: ReferenceChoice[] = SAMPLE_LIBRARY_DOCUMENTS
  .filter(item => item.kind === 'document' && item.status === 'ready')
  .map(item => ({ id: item.id, label: item.filename ?? '未命名文档' }));
export const SAMPLE_REFERENCE_HIGHLIGHTED = 0;
/** The small line under the picker, as the product shows it. */
export const SAMPLE_REFERENCE_FOOTNOTE = '每条消息最多引用 5 篇文档。AI 会按需读取引用文档的内容。';

export const SAMPLE_SKILLS: SkillChoice[] = [
  { moduleId: 'sample-skill-topics', name: '选题策划' },
  { moduleId: 'sample-skill-script', name: '口播稿写作' },
];
export const SAMPLE_SKILL_HINT = '加载到本对话，不自动发送';

/** The line under "从文件添加" when references are on. */
export const SAMPLE_FILE_HINT = '支持 TXT、Markdown、Word、PDF。文件会存进你的资料库，并作为引用加入本条消息。';

export const SAMPLE_COMPOSER_NOTE = '可以自由提问；Agent 按需查阅相关资料。Enter 发送，Shift + Enter 换行。';
