/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useRef, useState } from 'react';
import { restoredDraft } from '@/app/(zh-hans)/app/runtime/send-input';

/** Text this page put back is removed again only from where it put it: alone, or in front of a newer draft. */
export function withoutPutBack(current: string, text: string) {
  if (current === text) return '';
  return current.startsWith(text + '\n\n') ? current.slice(text.length + 2) : current;
}

/** Request ids whose text this page put back into the box; kept beside the draft so a reload still knows them. */
export function readPutBack(storage: Pick<Storage, 'getItem'>, key: string): Set<string> {
  try {
    const ids = JSON.parse(storage.getItem(key) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * The topic message box (same behaviour as the free-chat box, #872). It empties as soon as a message is sent;
 * the pending operation (with its request id) keeps the text. If the server does not store it, the text comes back
 * in front of anything typed since; if a later retry stores it after all, only that put-back copy is taken out.
 */
export function useTopicInput(inputKey: string) {
  const [input, setInput] = useState('');
  const putBackKey = inputKey ? inputKey + ':put-back' : '';
  const putBackIds = useRef(new Set<string>());
  useEffect(() => {
    if (!inputKey) return;
    setInput(localStorage.getItem(inputKey) ?? '');
    putBackIds.current = readPutBack(localStorage, putBackKey);
  }, [inputKey, putBackKey]);
  // Another tab on the same draft may have put text back or taken it out since; always act on the saved list.
  const reread = () => {
    if (putBackKey) putBackIds.current = readPutBack(localStorage, putBackKey);
  };
  // The draft is shared by every tab on this draft; edit the saved copy, not this tab's possibly stale state.
  const shared = (current: string) => (inputKey ? localStorage.getItem(inputKey) : null) ?? current;
  const remember = () => {
    if (!putBackKey) return;
    if (putBackIds.current.size) localStorage.setItem(putBackKey, JSON.stringify([...putBackIds.current]));
    else localStorage.removeItem(putBackKey);
  };
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
    /**
     * The message left the box; from here on the box and its draft hold only what is typed next. The shared draft is
     * removed only while it is still this message: another tab may have saved a newer one, which stays.
     */
    clearForSend(text: string) {
      setInput('');
      if (inputKey && (localStorage.getItem(inputKey) ?? '').trim() === text.trim()) localStorage.removeItem(inputKey);
    },
    /** Not stored (or held by a gate): the text goes back once per request, in front of any newer draft. */
    putBack(requestId: string, text: string) {
      reread();
      if (putBackIds.current.has(requestId)) return;
      putBackIds.current.add(requestId);
      remember();
      setInput(current => {
        const next = restoredDraft(shared(current), text);
        save(next);
        return next;
      });
    },
    /** Stored after all (a retry succeeded): take out only the copy this page put back, if it did. */
    stored(requestId: string, text: string) {
      reread();
      if (!putBackIds.current.delete(requestId)) return;
      remember();
      setInput(current => {
        const next = withoutPutBack(shared(current), text);
        save(next);
        return next;
      });
    },
  };
}
