/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { sidebarCreditsLabel } from './credits-label';

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
