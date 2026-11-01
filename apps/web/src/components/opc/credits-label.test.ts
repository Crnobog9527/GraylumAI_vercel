/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { sidebarCreditsLabel, turnBusyForCredits } from './credits-label';

it('shows the balance when nothing runs and remembers it', () => {
  expect(sidebarCreditsLabel({ status: 'ready', credits: 9352, busy: false, lastIdle: null })).toEqual({ label: 9352, idle: 9352 });
});
it('during a turn keeps the balance last seen idle instead of the near-zero balance the freeze leaves', () => {
  expect(sidebarCreditsLabel({ status: 'ready', credits: 0, busy: true, lastIdle: 9352 })).toEqual({ label: 9352, idle: 9352 });
});
it('a page opened mid-turn has seen no idle balance: it shows the neutral label, never 0', () => {
  expect(sidebarCreditsLabel({ status: 'ready', credits: 0, busy: true, lastIdle: null })).toEqual({ label: '查看', idle: null });
});
it('after the turn the real balance is shown again, a real zero included', () => {
  expect(sidebarCreditsLabel({ status: 'ready', credits: 0, busy: false, lastIdle: 9352 })).toEqual({ label: 0, idle: 0 });
  expect(sidebarCreditsLabel({ status: 'ready', credits: 9348, busy: false, lastIdle: 9352 }).label).toBe(9348);
});
it('an unavailable or loading balance is the neutral label', () => {
  expect(sidebarCreditsLabel({ status: 'unavailable', credits: null, busy: false, lastIdle: 5 })).toEqual({ label: '查看', idle: 5 });
});

it('a page reloaded mid-turn: the held-down balance that arrives before the turn state is never taken for an idle balance', () => {
  let idle: number | null = null;
  const render = (viewRead: boolean, busy: boolean, credits: number) => {
    const held = turnBusyForCredits({ viewRead, viewFailed: false, busy, paused: false });
    const shown = sidebarCreditsLabel({ status: 'ready', credits, busy: held, lastIdle: idle });
    idle = shown.idle;
    return shown.label;
  };
  expect(render(false, false, 0)).toBe('查看'); // the balance came first, nothing known of the turn
  expect(render(true, true, 0)).toBe('查看'); // the view says the turn runs
  expect(render(true, false, 9348)).toBe(9348); // the turn closed: the real balance
});
it('a failed read does not keep the balance away, and a pause for credits shows the real balance', () => {
  expect(turnBusyForCredits({ viewRead: false, viewFailed: true, busy: false, paused: false })).toBe(false);
  expect(turnBusyForCredits({ viewRead: true, viewFailed: false, busy: true, paused: true })).toBe(false);
  expect(turnBusyForCredits({ viewRead: true, viewFailed: false, busy: true, paused: false })).toBe(true);
});
