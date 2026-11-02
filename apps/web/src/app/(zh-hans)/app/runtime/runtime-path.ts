/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * CORE-PATH-V2: which workspace a conversation opens in. Every free conversation and work item runs on the turn path; the scope
 * of the conversation picks the workspace. Nothing renders before the conversation's scope has been read.
 */
export type RuntimePathInput = {
  /** `runtime.view` has answered (data or error). */
  viewSettled: boolean;
  scopeKind?: string;
};

export function runtimePathChoice(input: RuntimePathInput): 'loading' | 'turn' | 'work' | 'unreadable' {
  if (!input.viewSettled) return 'loading';
  return input.scopeKind === 'positioning_draft' ? 'turn' : input.scopeKind === 'work_item' ? 'work' : 'unreadable';
}
