/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * A reply cut off while it was being written (Owner 2026-11-11, MASTER_PLAN 2.1: "已经存下并交付的部分照常按回执结算"; review of
 * #1860). A model call that breaks off after it started (its 240 s limit, a dropped stream) ends the turn; whatever text the user has
 * already been shown is then saved as the turn's answer, so the turn closes as delivered and is charged by its receipts, like any
 * answered turn. Only a turn that showed nothing closes `interrupted` and pays nothing (turn_user_charge). Without this, asking a slow
 * model for a very long answer was a free answer every time: read as it streamed, cut at the limit, never charged.
 *
 * The truncation rules are those of CHAT_NATIVE_OUTPUT_PLAN 4.2: the cut is made on the visible prose only, never inside a protocol
 * JSON (a kind whose answer is one JSON document saves nothing when it is incomplete), a card is dropped (the user never saw it), and
 * half a character is never kept.
 */

/** The code the stream ends with when the shown part of a cut-off reply was saved (the page says so; turn-notices.ts). */
export const REPLY_CUT = 'TURN_REPLY_CUT';
/** turns.failure_code of a turn closed this way: completed and delivered, but with only the part that was shown. */
export const REPLY_CUT_FAILURE = 'turn_reply_cut';

/** The shown text, fit to save: without the first half of an emoji the cut left at its end, without trailing blanks; '' for nothing. */
export function shownSoFar(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  const whole = last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
  return whole.trimEnd();
}
