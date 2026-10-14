/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useCallback, useState } from 'react';
import type { ChoiceState } from './jury-adopt';

const keyOf = (reviewId: string) => `graylum:jury-choices:${reviewId}`;

function read(reviewId: string): ChoiceState {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(keyOf(reviewId));
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' ? value as ChoiceState : {};
  } catch {
    return {};
  }
}

/**
 * Chapter choices not yet submitted are a draft kept on this device, so "先不选，稍后回来" can resume them. The server
 * only learns the choices on adopt; the stored draft is a convenience, never the source of truth.
 */
export function useDraftChoices(reviewId: string) {
  const [state, setLocal] = useState<ChoiceState>(() => read(reviewId));
  const setState = useCallback((update: (value: ChoiceState) => ChoiceState) => {
    setLocal(value => {
      const next = update(value);
      try {
        window.localStorage.setItem(keyOf(reviewId), JSON.stringify(next));
      } catch {
        // Storage can be unavailable (private mode, blocked); the choices still work for this visit.
      }
      return next;
    });
  }, [reviewId]);
  const clear = useCallback(() => {
    try {
      window.localStorage.removeItem(keyOf(reviewId));
    } catch {
      // Nothing stored, nothing to clear.
    }
  }, [reviewId]);
  return { state, setState, clear };
}
