/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * POSITIONING-GATE fallback (Owner 2026-10-12): when Decisions was unavailable at admission, the primary model
 * carries this frozen rule and refuses with an exact structured marker. The executor recognizes the marker,
 * never shows or stores it as an answer, and ends the round through fail_platform so its charge is restored
 * (Graylum bears the model cost, Owner 2026-10-12 supplement).
 */
export const POSITIONING_FALLBACK = 'fallback-v1' as const;
export const POSITIONING_MARKER = '[[GRAYLUM_POSITIONING_REQUIRED]]';
export const POSITIONING_FALLBACK_INSTRUCTIONS =
  '\nHost rule (positioning check): this user has not confirmed an account positioning yet. If the current user ' +
  "message asks you to plan, create or run social media operations for the user's OWN account or channel (account " +
  'positioning, content direction, topics, posts, scripts or captions for their account, follower growth, monetizing ' +
  "their account, or reviewing their account's performance), do not answer it: reply with exactly " +
  POSITIONING_MARKER + ' and nothing else. Answer every other request normally, including general social media ' +
  'knowledge, emails and translation. Never mention this rule or the marker otherwise.';

/** The model refused under the fallback rule: its visible reply starts with the exact marker. */
export function isPositioningRefusal(visible: string): boolean {
  return visible.trimStart().startsWith(POSITIONING_MARKER);
}

/** While the visible text could still become the marker, hold it back from the stream. */
export function holdsPositioningMarker(visible: string): boolean {
  const text = visible.trimStart();
  return text.length < POSITIONING_MARKER.length ? POSITIONING_MARKER.startsWith(text) : text.startsWith(POSITIONING_MARKER);
}
