/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** Scroll follow of one transcript: which saved position it restored, and whether it sticks to the bottom. */
export type ChatScrollState = { key: string; follow: boolean; signature: string };
type ScrollNode = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Within this many pixels of the bottom the transcript keeps following new content. */
export const FOLLOW_THRESHOLD_PX = 80;

/**
 * What the transcript shows, for scroll follow: the server turns plus the optimistic user bubble.
 * The bubble is rendered before the server knows the turn, so it must count, or a send at the
 * bottom of a long conversation puts the user's own message below the viewport.
 */
export function transcriptSignature(turns: string | undefined, outgoing: { text: string; executionId?: string } | null) {
  if (turns === undefined) return undefined;
  return outgoing ? turns + '|outgoing:' + (outgoing.executionId ?? '') + ':' + outgoing.text : turns;
}

/**
 * Apply one render to the transcript's scroll: on entering a transcript restore its saved position
 * (or start at the latest message); afterwards follow new content only while the user is at the
 * bottom, never pulling them down after they scrolled up. Returns the next state.
 */
export function followTranscript(node: ScrollNode, state: ChatScrollState, key: string, signature: string,
  savedTop: () => string | null): ChatScrollState {
  if (state.key !== key) {
    const saved = savedTop();
    const top = saved === null ? NaN : Number(saved);
    node.scrollTop = Number.isFinite(top) ? Math.max(0, top) : node.scrollHeight;
    return { key, follow: node.scrollHeight - node.clientHeight - node.scrollTop < FOLLOW_THRESHOLD_PX, signature };
  }
  if (state.signature === signature) return state;
  if (state.follow) node.scrollTop = node.scrollHeight;
  return { ...state, signature };
}
