/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { RuntimeResultVersion, RuntimeSavedResult } from '../runtime-messages';

/**
 * Sample data for the work conversation display components (/app/runtime), shared by the landing
 * page and the component tests. Made-up example content only.
 */

export const SAMPLE_RUNTIME_HEADER = {
  title: '三分钟学会做司康',
  meta: { platform: '小红书', account: '烘焙小店', infoHref: '/app/library' },
};

export type SampleRuntimeTurn = {
  id: string;
  dateLabel?: string;
  userText?: string;
  completed?: boolean;
  /** A Skill reply on a topic shows as "建议稿"; otherwise a plain reply. */
  proposal?: { adopted: boolean };
  reply: string;
};

export const SAMPLE_RUNTIME_TURNS: SampleRuntimeTurn[] = [
  { id: 'sample-runtime-1', dateLabel: '今天 10:30', userText: '帮我想一版开头', completed: true, proposal: { adopted: false },
    reply: '**开头**：你做的司康总是不起层？其实只差一步——黄油一定要冷。' },
  { id: 'sample-runtime-2', userText: '再短一点，控制在 15 秒', reply: '好的，缩短后：\n\n> 司康不起层？黄油冷藏 20 分钟，再切进面粉。' },
];

export const SAMPLE_RUNTIME_PENDING = '就用这一版';

export const SAMPLE_CONTENT_DRAFT = {
  platform: '小红书', account: '烘焙小店', contentLabel: '口播稿',
  title: '三分钟学会做司康', body: '司康不起层？黄油冷藏 20 分钟，再切进面粉。', versionLine: '账号已保存 v2 · 草稿',
};

export const SAMPLE_CURRENT_SCRIPT_ID = 'sample-script-2';

export const SAMPLE_RESULT_VERSIONS: RuntimeResultVersion[] = [
  { id: 'sample-script-2', kind: 'script', version: 2, status: 'final', body: '口播稿正文', sourceContentId: null },
  { id: 'sample-board-1', kind: 'storyboard', version: 1, status: 'draft', body: '镜头 1：冷藏黄油特写\n镜头 2：切拌面粉', sourceContentId: 'sample-script-2' },
  { id: 'sample-edit-1', kind: 'editing', version: 1, status: 'final', body: '前 3 秒放成品掰开的画面', sourceContentId: 'sample-script-1' },
];

export const SAMPLE_SAVED_RESULTS: RuntimeSavedResult[] = [
  { artifactId: 'sample-artifact-1', version: 1, body: '封面标题备选：司康不起层的真正原因' },
];
