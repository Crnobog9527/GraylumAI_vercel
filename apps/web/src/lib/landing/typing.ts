/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Live typing on the landing page (round seven, T8: "那种非常丝滑的现场打字"): the coach writes about 35 characters a
 * second, a little faster and slower in turn; the visitor's own messages are typed into the message box a bit slower.
 */
export const COACH_CPS = 35;
export const USER_CPS = 22;

/**
 * Characters written `ms` after typing began, out of `length`. The pace wavers by up to ±40% (never stops or goes back:
 * the wave's slope stays under the base speed), so it reads as typing rather than a ticker.
 */
export function typedCount(ms: number, length: number, cps = COACH_CPS) {
  const t = Math.max(0, ms) / 1000;
  const wave = (cps * 0.08) * Math.sin(t * 5) + (cps * 0.016) * Math.sin(t * 11);
  return Math.max(0, Math.min(length, Math.floor(cps * t + wave)));
}

/** How long typing `length` characters takes (milliseconds), the wave included. */
export function typingMs(length: number, cps = COACH_CPS) {
  return Math.ceil(((length + cps * 0.1) / cps) * 1000);
}
