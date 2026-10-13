/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useRef, useState } from 'react';
import { restoredDraft } from '@/app/runtime/send-input';

/** Text this page put back is removed again only from where it put it: alone, or in front of a newer draft. */
export function withoutPutBack(current: string, text: string) {
  if (current === text) return '';
  return current.startsWith(text + '\n\n') ? current.slice(text.length + 2) : current;
}

/**
 * The topic message box (same behaviour as the free-chat box, #872). It empties as soon as a message is sent;
 * the pending operation (with its request id) keeps the text. If the server does not store it, the text comes back
 * in front of anything typed since; if a later retry stores it after all, only that put-back copy is taken out.
 */
export function useTopicInput(inputKey: string) {
  const [input, setInput] = useState('');
  const putBackIds = useRef(new Set<string>());
  useEffect(() => { if (inputKey) setInput(localStorage.getItem(inputKey) ?? ''); }, [inputKey]);
  const save = (value: string) => {
    if (!inputKey) return;
    if (value) localStorage.setItem(inputKey, value);
    else localStorage.removeItem(inputKey);
  };
  return {
    input,
    updateInput(value: string) {
      setInput(value);
      if (inputKey) localStorage.setItem(inputKey, value);
    },
    /** The message left the box; from here on the box and its draft hold only what is typed next. */
    clearForSend() {
      setInput('');
      save('');
    },
    /** Not stored (or held by a gate): the text goes back once per request, in front of any newer draft. */
    putBack(requestId: string, text: string) {
      if (putBackIds.current.has(requestId)) return;
      putBackIds.current.add(requestId);
      setInput(current => {
        const next = restoredDraft(current, text);
        save(next);
        return next;
      });
    },
    /** Stored after all (a retry succeeded): take out only the copy this page put back, if it did. */
    stored(requestId: string, text: string) {
      if (!putBackIds.current.delete(requestId)) return;
      setInput(current => {
        const next = withoutPutBack(current, text);
        save(next);
        return next;
      });
    },
  };
}
