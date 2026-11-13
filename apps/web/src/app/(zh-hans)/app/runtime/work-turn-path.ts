/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * CORE-PATH-V2 V2-10b C2 and CONTENT-CONVERSATION-2: the rules of a work item's saved content on the turn path: what a reply can be
 * saved as, the version a save expects, and the frozen request a repeat or a reload resumes.
 */
export type ContentVersion = {
  id: string;
  kind: string;
  version: number;
  status: string;
  body: string | null;
  title?: string | null;
  sourceContentId: string | null;
  turnId?: number | null;
  requestId: string;
};
/** CONTENT-CONVERSATION-2: what a reply of the topic window can be saved as, by the item's content type (Owner 2026-11-14: the user
 *  says what to write in the conversation and saves the version they want with a button under it). */
export type SaveKind = 'brief' | 'script' | 'storyboard' | 'editing';
export const SAVE_KINDS: Record<string, ReadonlyArray<{ kind: SaveKind; label: string }>> = {
  video: [{ kind: 'script', label: '口播稿' }, { kind: 'storyboard', label: '分镜' }, { kind: 'editing', label: '剪辑建议' }],
  article: [{ kind: 'brief', label: '正文' }],
  image_text: [{ kind: 'brief', label: '正文' }]
};
/** A save frozen in this browser first, so a repeat or a reload resumes that request and never makes a second version. */
export type SaveOperation = { kind: SaveKind; workItemId: string; requestId: string; turnId: number; expectedVersion: number };
/** The body is the article's working draft; a video's script, storyboard and editing advice are saved as final. */
export const saveStatus = (kind: SaveKind) => (kind === 'brief' ? 'draft' : 'final');

export const SAVE_REJECTIONS = new Set([
  'OPC_VERSION_CONFLICT',
  'OPC_REQUEST_CONFLICT',
  'OPC_CONTENT_DENIED',
  'OPC_CONTENT_INVALID',
  'OPC_CONTENT_SOURCE',
  'OPC_VIDEO_TYPE_REQUIRED'
]);
/** What a definite refusal of a save tells the user. */
export function saveRefusal(code: string, kind: SaveKind): string {
  if (code === 'OPC_CONTENT_SOURCE')
    return kind === 'editing'
      ? '写这条回复时还没有已保存的分镜，不能存为剪辑建议。请先把分镜存好，再让我基于它写剪辑建议。'
      : '写这条回复时还没有已定稿的口播稿，不能存为分镜。请先把口播稿存好，再让我基于它出分镜。';
  if (code === 'OPC_CONTENT_INVALID') return '这条回复是空的或超过 2 万字，不能保存。';
  if (code === 'OPC_VERSION_CONFLICT' || code === 'OPC_REQUEST_CONFLICT') return '这类内容刚刚有了新版本，已读取最新内容，请再点一次保存。';
  return '保存已明确拒绝（' + code + '），请刷新后核对。';
}
export const WORK_CONTINUE = '[OPC_WORK_CONTINUE_V1]';
export const VIDEO_PACKAGE = '[OPC_VIDEO_PACKAGE_V1]';

export const latestVersion = (versions: readonly ContentVersion[], kind: string) =>
  versions.filter(v => v.kind === kind).reduce((n, v) => Math.max(n, v.version), 0);
export const currentFinalScript = (versions: readonly ContentVersion[]) =>
  versions.filter(v => v.kind === 'script' && v.status === 'final').sort((a, b) => b.version - a.version)[0] ?? null;

/** A reply the user can save: not the opening guide's, not an old package's (CONTENT-CONVERSATION-2: any Skill or none). */
export const savable = (asked: string | null) => !asked?.startsWith(WORK_CONTINUE) && !asked?.startsWith(VIDEO_PACKAGE);

export const guideRequest = (stage: string, label: string) =>
  `${WORK_CONTINUE} 工作阶段 ${stage}。用户选择继续这条${label}选题。` +
  '请遵循当前Skill，结合现有简报、对话与已保存成果，判断当前进度与适合的讨论方式。' +
  `不要直接生成正文或口播稿，不要生成分镜、剪辑、图片、视频或发布；已定稿后只询问下一步意愿。`;

