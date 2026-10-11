/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { appRouter } from '../root';

it('removes legacy slice and guided-chat procedures while retaining active workspace procedures', () => {
  const procedures = Object.keys(appRouter._def.procedures);
  expect(procedures.filter(name => name.startsWith('agentSlice.'))).toEqual([]);
  expect(procedures.filter(name => name.startsWith('workbench.chat'))).toEqual([]);
  for (const name of ['workbench.execute', 'workbench.read', 'workbench.report',
    'workbench.export', 'runtime.executeStream', 'opc.mentorTurnStream']) {
    expect(procedures).toContain(name);
  }
});
