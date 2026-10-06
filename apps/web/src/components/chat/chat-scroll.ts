/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** Scroll follow of one transcript: which saved position it restored, and whether it sticks to the bottom. */
export type ChatScrollState = { key: string; follow: boolean; signature: string };
type ScrollNode = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Within this many pixels of the bottom the transcript keeps following new content. */
export const FOLLOW_THRESHOLD_PX = 80;

/** Whether the reader is at (or within the follow threshold of) the bottom of the transcript. */
export function isNearBottom(node: ScrollNode, threshold = FOLLOW_THRESHOLD_PX) {
  return node.scrollHeight - node.clientHeight - node.scrollTop < threshold;
}

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

/**
 * Keep a transcript pinned to the bottom whenever its content or its own height changes, while
 * `following()` says the reader is there. Watching the DOM instead of a list of React values covers
 * everything that grows the transcript (streamed text, cards, notices, a docked composer shrinking it).
 * Returns the cleanup.
 */
export function pinToBottomOnGrowth(node: HTMLElement, following: () => boolean) {
  const pin = () => { if (following() && !isNearBottom(node, 1)) node.scrollTop = node.scrollHeight; };
  // A ResizeObserver reports every element once when observed; only a later, real size change may pin,
  // so a restored position near (but not at) the bottom is not overwritten.
  const heights = new WeakMap<Element, number>();
  const sizes = new ResizeObserver(entries => {
    let grew = false;
    for (const entry of entries) {
      const before = heights.get(entry.target), height = entry.contentRect.height;
      if (before !== undefined && before !== height) grew = true;
      heights.set(entry.target, height);
    }
    if (grew) pin();
  });
  const watch = () => {
    sizes.disconnect();
    sizes.observe(node);
    for (const child of Array.from(node.children)) sizes.observe(child);
  };
  const changes = new MutationObserver(() => { watch(); pin(); });
  watch();
  changes.observe(node, { childList: true, subtree: true, characterData: true });
  return () => { changes.disconnect(); sizes.disconnect(); };
}
