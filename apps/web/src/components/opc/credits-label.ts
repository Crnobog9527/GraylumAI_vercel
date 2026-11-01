/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * CORE-PATH-V2 V2-10: while a conversation turn runs, its freeze is held out of the balance (the freeze is as large as the turn's upper
 * bound, so a balance below it reads nearly 0 for the whole turn). The sidebar must not show that 0 as the user's balance: during a turn it
 * keeps the balance last seen when nothing was running, and where none was seen (the page was opened mid-turn) shows the neutral label
 * until the turn closes. The account page and the credit records are not touched.
 */
export type CreditsStatus = 'loading' | 'ready' | 'unavailable';

export function sidebarCreditsLabel(input: { status: CreditsStatus; credits: number | null; busy: boolean; lastIdle: number | null }):
  { label: number | '查看'; idle: number | null } {
  if (input.status !== 'ready' || input.credits === null) return { label: '查看', idle: input.lastIdle };
  if (input.busy) return { label: input.lastIdle ?? '查看', idle: input.lastIdle };
  return { label: input.credits, idle: input.credits };
}
