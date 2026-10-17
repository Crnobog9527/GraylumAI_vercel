/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import type { OpsLine } from '@/lib/landing/landing-copy-l';

/**
 * Sample O (direction C, "路线图", Owner 2026-10-17). The only new words on the page are the three station names the
 * direction itself names; every other line is sample L's.
 */
export const O_STATIONS = {
  voice: '你现在在这',
  samples: '别人走到了这',
  price: '从这里出发',
  /** The close is always the route's end. */
  end: '10',
} as const;

/** The messages of one step the chat window shows (as OpsChatL filters them). */
export const shownLines = (lines: readonly OpsLine[], flags: LandingFlags) =>
  lines.filter(line => allOn(flags, line.needs) && !(line.without && allOn(flags, [line.without])));

/**
 * The numbered notes beside region 3's window, made only of the step's own line (L_OPS): when the step opens with the
 * person's message, the line's first part (up to its first comma) points at that message and the rest at the coach's
 * answer; otherwise the whole line points at the first message. `at` is the message's place in the window.
 */
export function stepNotes(line: string, lines: readonly OpsLine[]): { at: number; text: string }[] {
  const cut = line.indexOf('，');
  if (lines[0]?.role === 'user' && lines.length > 1 && cut > 0) {
    return [{ at: 0, text: line.slice(0, cut) }, { at: 1, text: line.slice(cut + 1) }];
  }
  return [{ at: 0, text: line }];
}
