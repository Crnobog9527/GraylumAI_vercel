/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";

import { useEffect, useRef, useState, type UIEvent } from "react";
import { pinToBottomOnGrowth } from "@/components/chat/chat-scroll";

const atBottom = (node: HTMLElement) => node.scrollHeight - node.clientHeight - node.scrollTop < 64;

/**
 * Scroll of the mentor log: on first load restore this tab's saved position (or start at the latest
 * message), then follow new content only while the reader is at the bottom. Nothing follows or saves
 * before the restore, and afterwards only a real size change pins: history, the pending bubble and
 * the live reply check after React updates; anything else that grows the log (cards, notices, the
 * next question, a docked card shrinking it) is followed by watching the DOM. A refetch or a DOM
 * change that leaves the sizes alone keeps a restored position near (but not at) the bottom.
 */
export function useMentorLogScroll(draftId: string, history: unknown, pendingBubble: unknown, liveReply: unknown) {
  const [node, attach] = useState<HTMLDivElement | null>(null);
  const restored = useRef<HTMLDivElement | null>(null), follow = useRef(true);
  const pin = useRef<ReturnType<typeof pinToBottomOnGrowth> | null>(null);
  const key = "opc-position-chat-scroll:" + draftId;
  useEffect(() => {
    if (!node) return;
    const pinner = pinToBottomOnGrowth(node, () => restored.current === node && follow.current);
    pin.current = pinner;
    return () => { pinner.stop(); if (pin.current === pinner) pin.current = null; };
  }, [node]);
  useEffect(() => {
    if (!node || !history) return;
    if (restored.current !== node) {
      const saved = sessionStorage.getItem(key);
      node.scrollTop = saved === null ? node.scrollHeight : Number(saved) || 0;
      follow.current = atBottom(node);
      restored.current = node;
      pin.current?.rebase();
    } else pin.current?.check();
  }, [node, history, key, pendingBubble, liveReply]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    follow.current = atBottom(target);
    if (restored.current === target) sessionStorage.setItem(key, String(target.scrollTop));
  };
  return { attach, follow, onScroll };
}
