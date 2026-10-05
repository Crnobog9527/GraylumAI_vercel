/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";

import { useEffect, useRef, useState, type UIEvent } from "react";
import { pinToBottomOnGrowth } from "@/components/chat/chat-scroll";

const atBottom = (node: HTMLElement) => node.scrollHeight - node.clientHeight - node.scrollTop < 64;

/**
 * Scroll of the mentor log: on first load restore this tab's saved position (or start at the latest
 * message), then follow new content only while the reader is at the bottom. History, the pending
 * bubble and the live reply re-pin after React updates; anything else that grows the log (cards,
 * notices, the next question, a docked card shrinking it) is followed by watching the DOM.
 */
export function useMentorLogScroll(draftId: string, history: unknown, pendingBubble: unknown, liveReply: unknown) {
  const [node, attach] = useState<HTMLDivElement | null>(null);
  const restored = useRef<HTMLDivElement | null>(null), follow = useRef(true);
  const key = "opc-position-chat-scroll:" + draftId;
  useEffect(() => {
    if (!node || !history) return;
    if (restored.current !== node) {
      const saved = sessionStorage.getItem(key);
      node.scrollTop = saved === null ? node.scrollHeight : Number(saved) || 0;
      follow.current = atBottom(node);
      restored.current = node;
    } else if (follow.current) node.scrollTop = node.scrollHeight;
  }, [node, history, key, pendingBubble, liveReply]);
  useEffect(() => node ? pinToBottomOnGrowth(node, () => restored.current === node && follow.current) : undefined, [node]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    follow.current = atBottom(target);
    if (restored.current === target) sessionStorage.setItem(key, String(target.scrollTop));
  };
  return { attach, follow, onScroll };
}
