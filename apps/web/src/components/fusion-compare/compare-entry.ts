/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * The rail's "多模型对比" entry and the page that can run a compare (Owner 2026-11-12: the entry belongs in the left rail,
 * not beside the message box). A compare needs the question in the message box and the conversation it belongs to, which
 * only the page knows: the page with a message box registers itself as the host, and the rail asks it. Without a host
 * (the library, the data review …) the rail opens the new-conversation page instead, which then asks once it is there.
 */
type CompareHostHandler = () => void;
let host: CompareHostHandler | null = null;

/** Registers the page's handler; the returned function takes it away again (only if it is still the one registered). */
export function registerCompareHost(handler: CompareHostHandler): () => void {
  host = handler;
  return () => { if (host === handler) host = null; };
}

/** Asks the page to start a compare with what is in its message box. False when this page cannot run one. */
export function askCompare(): boolean {
  if (!host) return false;
  host();
  return true;
}

/** Where the rail goes when the page has no message box, and the mark the new-conversation page reads to ask on arrival. */
export const COMPARE_ENTRY_PARAM = 'compare';
export const COMPARE_ENTRY_HREF = `/app/positioning?${COMPARE_ENTRY_PARAM}=1`;
/** The words under the message box when the entry is used before anything is written (the old button's hint). */
export const COMPARE_NEEDS_QUESTION = '先写好问题再对比';
