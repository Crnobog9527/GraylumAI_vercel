/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Frozen at admission (new executions only) on every execution that offers the owned-source read (`read_source`): a response
 * with several parallel read_source calls executes only the first (the transport keeps all of them as paid evidence,
 * bill2/openRouterStream.ts SOURCE_STREAM_TOOLS). Executions admitted before this marker existed do not carry it, so their
 * request bytes and replay are exactly as before.
 */
export const SOURCE_CALLS_FIRST = 'first-call-v1' as const;

/** The context fields admission freezes for library retrieval and first-call-only source reads. */
export function sourceReadFlags(libraryRetrieval: boolean, sourceTools: readonly string[]) {
  return {
    ...(libraryRetrieval ? {libraryRetrieval: true as const} : {}),
    ...(sourceTools.includes('read_source') ? {sourceCalls: SOURCE_CALLS_FIRST} : {}),
  };
}
