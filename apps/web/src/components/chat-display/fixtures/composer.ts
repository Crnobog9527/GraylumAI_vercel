/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
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

/** The `@` picker: ready library documents matching what was typed after `@`. */
export const SAMPLE_REFERENCE_CHOICES: ReferenceChoice[] = [
  { id: 'sample-doc-1', label: '品牌介绍.pdf' },
  { id: 'sample-doc-2', label: '去年爆款笔记.md' },
  { id: 'sample-doc-3', label: '客户常见问题.docx' },
];
export const SAMPLE_REFERENCE_HIGHLIGHTED = 0;

export const SAMPLE_SKILLS: SkillChoice[] = [
  { moduleId: 'sample-skill-topics', name: '选题策划' },
  { moduleId: 'sample-skill-script', name: '口播稿写作' },
];
export const SAMPLE_SKILL_HINT = '加载到本对话，不自动发送';

export const SAMPLE_COMPOSER_NOTE = '可以自由提问；Agent 按需查阅相关资料。Enter 发送，Shift + Enter 换行。';
