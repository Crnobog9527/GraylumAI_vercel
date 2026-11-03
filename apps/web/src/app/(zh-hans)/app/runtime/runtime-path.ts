/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * CORE-PATH-V2: which workspace a conversation opens in. Every free conversation and work item runs on the turn path; the scope
 * of the conversation picks the workspace. Nothing renders before the conversation's scope has been read. A conversation the old
 * execution path produced (no turn-path scope, or `legacy` from `runtime.view`) is not shown: it gets a plain notice.
 */
export type RuntimePathInput = {
  /** `runtime.view` has answered (data or error). */
  viewSettled: boolean;
  /** The answer was an error: the conversation is unreadable right now, not old. */
  viewFailed?: boolean;
  scopeKind?: string;
  /** `runtime.view`'s flag for a conversation without turns; absent until the server sends it. */
  legacy?: boolean;
};

export function runtimePathChoice(input: RuntimePathInput): 'loading' | 'turn' | 'work' | 'legacy' | 'unreadable' {
  if (!input.viewSettled) return 'loading';
  if (input.viewFailed) return 'unreadable';
  if (input.legacy) return 'legacy';
  return input.scopeKind === 'positioning_draft' ? 'turn' : input.scopeKind === 'work_item' ? 'work' : 'legacy';
}

export const LEGACY_CONVERSATION_NOTICE = '这个对话是旧版本产生的，已不再支持查看。';
