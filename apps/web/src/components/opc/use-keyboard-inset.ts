/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect } from 'react';

/** Smaller differences are the browser's own bars sliding in and out, not a keyboard. */
const KEYBOARD_MIN = 80;

/**
 * What the on-screen keyboard covers at the foot of the page, in px (0 without one). `scale` is the pinch zoom: a zoomed-in
 * page also shows less than its layout height, and that is not a keyboard. Exported for its test.
 */
export function keyboardInset(layoutHeight: number, visibleHeight: number, scale = 1): number {
  if (Math.abs(scale - 1) > 0.01) return 0;
  const covered = Math.round(layoutHeight - visibleHeight);
  return covered > KEYBOARD_MIN ? covered : 0;
}

/**
 * Keeps `--keyboard-inset` on the document while `active`: the height the on-screen keyboard covers. A phone's keyboard does
 * not make the page shorter (iOS Safari never did; Chrome on Android stopped in version 108), so a message box at the foot of
 * a full-height page would sit under it. The conversation pages subtract this from their height on a phone
 * (workspace-frame.module.css), which puts the box right above the keyboard. When the browser has also slid the page up to
 * show the caret, it is put back: the box is already in view. Without a keyboard, and on a computer, the value is 0px.
 */
export function useKeyboardInset(active = true): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) return;
    const root = document.documentElement;
    // Only a phone's width uses the value (the same 639px as the CSS that reads it); elsewhere it stays 0px.
    const phone = window.matchMedia('(max-width:639px)');
    const update = () => {
      const inset = phone.matches ? keyboardInset(window.innerHeight, viewport.height, viewport.scale) : 0;
      root.style.setProperty('--keyboard-inset', `${inset}px`);
      if (inset && (viewport.offsetTop > 0 || window.scrollY > 0)) window.scrollTo(0, 0);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--keyboard-inset');
    };
  }, [active]);
}
