/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { getErrorMessageText } from '@/lib/safe-error-message';

/** The four targets the D7 backend (#766) supports. Do not add kinds here without a backend change. */
export type ContentErasureKind = 'answer' | 'session' | 'artifact' | 'content';
export type ContentErasureTarget = { kind: ContentErasureKind; id: string };
export type ContentErasurePreview = ContentErasureTarget & {
  alreadyDeleted: boolean;
  affectedExecutions: number;
  preservedSavedVersions: number;
  affectedSources: Array<{ kind: 'account' | 'work_item' | 'reference' | 'content'; id: string }>;
  previewHash: string;
};
export type ContentErasureResult = ContentErasureTarget & {
  status: 'deleted' | 'review_required';
  alreadyDeleted: boolean;
  preservedSavedVersions: number;
  financialReviewCount: number;
};
export type ErasureLine = { tone: 'warn' | 'info'; text: string };

export const ERASURE_TITLE: Record<ContentErasureKind, string> = {
  answer: '永久删除这条回答',
  session: '永久删除这个对话',
  artifact: '永久删除这份成果',
  content: '永久删除这份稿件',
};

const REMOVED: Record<ContentErasureKind, string> = {
  answer: '这条回答和系统根据它生成的副本会被永久删除。你的提问会保留；用到这条回答的后续执行不能再重放。',
  session: '这个对话的全部消息、工具记录和系统整理会被永久删除。',
  artifact: '这份成果的全部历史版本、候选草稿和系统副本会被永久删除。',
  content: '这份稿件的全部版本（自动保存、定稿和历史版本）会被永久删除，不只是当前这一版。',
};

const SOURCE_LABEL: Record<ContentErasurePreview['affectedSources'][number]['kind'], string> = {
  account: '个账号定位',
  work_item: '条选题工作',
  reference: '项引用',
  content: '份稿件',
};

/**
 * Plain consequences of confirming (DATA-ERASURE §5, E8). The retained-results line never states a
 * count: the backend count can miss results saved several steps away (#766 P2), so it is not a promise.
 */
export function buildContentErasureLines(preview: ContentErasurePreview): ErasureLine[] {
  const lines: ErasureLine[] = [{ tone: 'warn', text: REMOVED[preview.kind] }];
  const counts = new Map<string, number>();
  for (const source of preview.affectedSources) {
    counts.set(source.kind, (counts.get(source.kind) ?? 0) + 1);
  }
  if (counts.size > 0) {
    const parts = (Object.keys(SOURCE_LABEL) as Array<keyof typeof SOURCE_LABEL>)
      .filter((kind) => counts.has(kind))
      .map((kind) => `${counts.get(kind)} ${SOURCE_LABEL[kind]}`);
    lines.push({
      tone: 'warn',
      text: `有 ${parts.join('、')}以它为来源。它们会保留，但来源将不可读，之后需要重新选择来源或复核。`,
    });
  }
  lines.push({ tone: 'info', text: '你另外保存的独立成果不会被删除，会显示“来源已不可用”，如不需要可以另行删除。' });
  lines.push({ tone: 'warn', text: '删除后无法恢复，没有回收站。' });
  lines.push({ tone: 'info', text: '删除内容不会退还已产生的费用；必要的账务记录按规则保留。' });
  return lines;
}

export function describeErasureResult(result: ContentErasureResult): string {
  if (result.status === 'review_required') {
    return '内容已不可读取，部分账务记录仍在核对中。核对完成前不代表全部清理完毕。';
  }
  return result.alreadyDeleted ? '这项内容之前已经永久删除。' : '已永久删除。';
}

const CONFIRM_ERRORS: Array<[string, string]> = [
  ['CONTENT_NOT_FOUND', '找不到这项内容，或你没有权限删除它。'],
  ['CONTENT_ERASURE_BUSY', '这项内容正在使用中（例如回复还在生成），本次没有删除任何内容。请稍后刷新再试。'],
];

export type ErasureFailure = 'gone' | 'changed' | 'message';

/** Map a failed call to a user-facing outcome; raw codes and server text are never shown. */
export function classifyErasureError(error: unknown, phase: 'preview' | 'confirm'): { type: ErasureFailure; message: string } {
  const text = getErrorMessageText(error);
  if (text.includes('CONTENT_ERASED')) {
    return { type: 'gone', message: '这项内容已经永久删除。' };
  }
  if (text.includes('CONTENT_ERASURE_PREVIEW_CHANGED')) {
    return { type: 'changed', message: '删除影响刚刚发生了变化，已重新读取。请核对后再确认。' };
  }
  const known = CONFIRM_ERRORS.find(([code]) => text.includes(code));
  if (known) {
    return { type: 'message', message: known[1] };
  }
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  if (code === 'TOO_MANY_REQUESTS') {
    return { type: 'message', message: '操作太频繁，请稍后再试。' };
  }
  if (code === 'UNAUTHORIZED') {
    return { type: 'message', message: '登录已过期，请重新登录后再试。' };
  }
  return {
    type: 'message',
    message: phase === 'preview'
      ? '暂时无法读取删除影响，请稍后重试。'
      : '删除结果暂未确认，请不要当作已删除。可以再次确认，重复确认不会重复删除或扣费。',
  };
}

export type ErasureCacheUtils = {
  opc: { invalidate: () => Promise<unknown> };
  runtime: { invalidate: () => Promise<unknown> };
  account: { contentErasurePreview: { invalidate: () => Promise<unknown> } };
};

/** Every list or view that can show OPC or Runtime content refetches; nothing positive stays cached. */
export function refreshAfterErasure(utils: ErasureCacheUtils): Promise<unknown> {
  return Promise.all([
    utils.opc.invalidate(),
    utils.runtime.invalidate(),
    utils.account.contentErasurePreview.invalidate(),
  ]);
}

/**
 * Drops this browser's local drafts and pending requests that name a deleted object, in the key or
 * inside the stored value (recovery records are often keyed by the owning work item or session).
 */
export function forgetLocalCopies(ids: string[], stores: Array<Storage | null | undefined>) {
  const wanted = ids.filter(Boolean);
  if (!wanted.length) return;
  for (const store of stores) {
    if (!store) continue;
    try {
      const keys: string[] = [];
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (!key) continue;
        const value = store.getItem(key) ?? '';
        if (wanted.some((id) => key.includes(id) || value.includes(id))) keys.push(key);
      }
      keys.forEach((key) => store.removeItem(key));
    } catch {
      // Storage can be unavailable in private modes; the server state is authoritative.
    }
  }
}

export const ERASURE_CHANNEL = 'graylum-content-erasure';

/** Tells other open tabs to refetch, so deleted content disappears there too. */
export function announceErasure(target: ContentErasureTarget, relatedIds: string[] = []) {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(ERASURE_CHANNEL);
    channel.postMessage({ kind: target.kind, id: target.id, relatedIds });
    channel.close();
  } catch {
    // Other tabs still refetch on focus and on their next poll.
  }
}

export type ConfirmOutcome =
  | { type: 'done'; message: string; reviewRequired: boolean }
  | { type: 'changed'; message: string }
  | { type: 'error'; message: string };

export type ConfirmDeps = {
  confirm: (input: ContentErasureTarget & { previewHash: string; acknowledged: true }) => Promise<ContentErasureResult>;
  /** Refetch every cached view, announce to other tabs and drop local copies. */
  afterErasure: (target: ContentErasureTarget) => Promise<unknown>;
};

/** One confirmation attempt against the exact preview the user read. */
export async function confirmContentErasure(
  deps: ConfirmDeps,
  preview: ContentErasurePreview,
): Promise<ConfirmOutcome> {
  const target = { kind: preview.kind, id: preview.id };
  try {
    const result = await deps.confirm({ ...target, previewHash: preview.previewHash, acknowledged: true });
    await deps.afterErasure(target);
    return { type: 'done', message: describeErasureResult(result), reviewRequired: result.status === 'review_required' };
  } catch (error) {
    const failure = classifyErasureError(error, 'confirm');
    if (failure.type === 'gone') {
      await deps.afterErasure(target);
      return { type: 'done', message: failure.message, reviewRequired: false };
    }
    if (failure.type === 'changed') {
      return { type: 'changed', message: failure.message };
    }
    return { type: 'error', message: failure.message };
  }
}
