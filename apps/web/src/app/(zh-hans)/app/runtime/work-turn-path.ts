/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { VideoChoice } from './work-input';

/*
 * CORE-PATH-V2 V2-10b C2: the rules of a work item's saved content on the turn path, as the old page's: what a reply's version is,
 * which version a video continues from, and the frozen request a repeat or a reload resumes.
 */
export type ContentVersion = { id: string; kind: string; version: number; status: string; body: string | null; title?: string | null;
  sourceContentId: string | null; executionId: string | null; turnId?: number | null; requestId: string };
export type VideoOperation = { workItemId: string; choice: VideoChoice; moduleId: string; script: { requestId: string; turnId: number; expectedVersion: number };
  sourceScriptId: string; followup: { requestId: string; input: string }; package: { expectedStoryboardVersion: number; expectedEditingVersion: number }; held?: boolean };
export type ScriptOperation = { kind: 'brief' | 'script'; workItemId: string; requestId: string; turnId: number; expectedVersion: number };

export const VIDEO_REJECTIONS = new Set(['OPC_VERSION_CONFLICT', 'OPC_REQUEST_CONFLICT', 'OPC_CONTENT_DENIED', 'OPC_CONTENT_BINDING', 'OPC_CONTENT_RESPONSE_INVALID',
  'OPC_CONTENT_SOURCE', 'OPC_CONTENT_ALREADY_GENERATED', 'OPC_CONTENT_CHOICE_INVALID', 'OPC_STORYBOARD_REQUIRED', 'OPC_VIDEO_TYPE_REQUIRED']);
export const SCRIPT_REJECTIONS = new Set(['OPC_VERSION_CONFLICT', 'OPC_REQUEST_CONFLICT', 'OPC_CONTENT_DENIED', 'OPC_CONTENT_INVALID', 'OPC_CONTENT_SOURCE',
  'OPC_VIDEO_TYPE_REQUIRED']);
export const WORK_CONTINUE = '[OPC_WORK_CONTINUE_V1]';
export const VIDEO_PACKAGE = '[OPC_VIDEO_PACKAGE_V1]';

export const latestVersion = (versions: readonly ContentVersion[], kind: string) =>
  versions.filter(v => v.kind === kind).reduce((n, v) => Math.max(n, v.version), 0);
export const currentFinalScript = (versions: readonly ContentVersion[]) =>
  versions.filter(v => v.kind === 'script' && v.status === 'final').sort((a, b) => b.version - a.version)[0] ?? null;

/** The turn a final script came from: manual revisions keep their written ancestor; chain length is not a validity limit. A version from
 *  an old execution has no turn here: a conversation with old history stays on the old path. */
export function scriptSourceTurn(versions: readonly ContentVersion[], script: ContentVersion | null): number | null {
  const byId = new Map(versions.filter(v => v.kind === 'script').map(v => [v.id, v]));
  const seen = new Set<string>();
  for (let cursor = script; cursor; cursor = cursor.sourceContentId ? byId.get(cursor.sourceContentId) ?? null : null) {
    if (seen.has(cursor.id)) return null;
    seen.add(cursor.id);
    if (cursor.turnId) return cursor.turnId;
  }
  return null;
}

/** A reply the user can adopt: a Skill's, not a guide's or a package's. */
export const adoptable = (workSkill: boolean | null | undefined, asked: string | null) =>
  Boolean(workSkill) && !asked?.startsWith(WORK_CONTINUE) && !asked?.startsWith(VIDEO_PACKAGE);

export function videoRequest(choice: VideoChoice) {
  const requested = choice === 'both' ? '生成分镜脚本和剪辑建议' : choice === 'storyboard' ? '只生成分镜脚本' : '只生成剪辑建议';
  const fields = choice === 'both' ? 'storyboard 与 editing 两个字符串字段' : choice === 'storyboard' ? 'storyboard 一个字符串字段' : 'editing 一个字符串字段';
  return `${VIDEO_PACKAGE} 用户已明确同意：基于资料中已定稿的口播稿，${requested}。遵循当前 Skill 的创作方法：剪辑建议必须基于匹配当前口播稿的分镜；仅剪辑时必须依据资料中已保存的分镜，不得跳过分镜或自行补造。只返回严格 JSON 对象，且只含 ${fields}；不要生成图片、视频或执行发布。`;
}
export const guideRequest = (stage: string, label: string) =>
  `${WORK_CONTINUE} 工作阶段 ${stage}。用户选择继续这条${label}选题。请遵循当前Skill，结合现有简报、对话与已保存成果，判断当前进度与适合的讨论方式。不要直接生成正文或口播稿，不要生成分镜、剪辑、图片、视频或发布；已定稿后只询问下一步意愿。`;

/** The saved reply of a request, on the view read after its turn: none while it runs, or if it delivered nothing. */
export const replyOfRequest = (messages: ReadonlyArray<{ role: string; requestId?: string | null; turnId: number | null }>, requestId: string) =>
  messages.find(m => m.role === 'assistant' && m.requestId === requestId)?.turnId ?? null;
