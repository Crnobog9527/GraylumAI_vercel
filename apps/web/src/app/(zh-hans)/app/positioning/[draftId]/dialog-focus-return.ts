/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useRef } from "react";

/**
 * A dialog opened from state, not from a Radix Trigger, has nothing to give focus back to: after 取消 or Esc focus fell to <body>, and
 * the next Esc or Tab was no longer inside the page it came from. `remember()` is called just before the dialog opens and records the
 * control that had focus (or `fallback()`'s element when none had, e.g. a button clicked in Safari); `onCloseAutoFocus` puts focus back
 * there when the dialog closes. If the remembered control is gone, Radix's own default applies.
 */
export function useDialogFocusReturn(fallback?: () => HTMLElement | null) {
  const origin = useRef<HTMLElement | null>(null);
  return {
    remember() {
      const active = document.activeElement;
      origin.current = active instanceof HTMLElement && active !== document.body ? active : fallback?.() ?? null;
    },
    onCloseAutoFocus(event: Event) {
      const target = origin.current;
      origin.current = null;
      if (!target?.isConnected) return;
      event.preventDefault();
      target.focus();
    },
  };
}
