/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { isPositioningWorkflow } from './positioningWorkflow';

it('matches only workflows whose every step has fields and some field feeds the profile', () => {
  expect(isPositioningWorkflow({ steps: [{ information: [{ profileKey: 'audience' }] }, { information: [{ id: 'x' }] }] })).toBe(true);
  expect(isPositioningWorkflow({ steps: [{ information: [{ profileKey: 'audience' }] }, { resources: ['a.md'] }] })).toBe(false);
  expect(isPositioningWorkflow({ steps: [{ information: [{ id: 'x' }] }] })).toBe(false);
  expect(isPositioningWorkflow({ steps: [{ information: [] }] })).toBe(false);
  for (const value of [{ steps: [] }, {}, null, undefined, 'x', { steps: [null] }]) expect(isPositioningWorkflow(value)).toBe(false);
});
