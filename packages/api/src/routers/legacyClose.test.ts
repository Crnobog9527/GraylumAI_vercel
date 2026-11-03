/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { appRouter } from '../root';

it('removes legacy slice and guided-chat procedures while retaining active workspace procedures', () => {
  const procedures = Object.keys(appRouter._def.procedures);
  expect(procedures.filter(name => name.startsWith('agentSlice.'))).toEqual([]);
  expect(procedures.filter(name => name.startsWith('workbench.chat'))).toEqual([]);
  expect(procedures.filter(name => name.startsWith('ai.'))).toEqual([]);
  for (const name of ['workbench.generate', 'workbench.search', 'workbench.createWork', 'workbench.report', 'workbench.export']) {
    expect(procedures).not.toContain(name);
  }
  for (const name of ['workbench.catalog', 'workbench.read', 'workbench.start', 'workbench.execute',
    'runtime.start', 'runtime.choices', 'runtime.view', 'opc.start', 'opc.captureResolve']) {
    expect(procedures).toContain(name);
  }
});

// CORE-PATH-V2 V2-12 F-Node: the old execution model has no procedure left. A turn is sent with POST /api/turn; an old one is
// never reachable again through tRPC.
it('removes the old execution procedures: nothing can start, resume, stop or stream an old execution', () => {
  const procedures = Object.keys(appRouter._def.procedures);
  for (const name of ['runtime.prepare', 'runtime.executeStream', 'runtime.resume', 'runtime.resumeStream', 'runtime.cancel',
    'opc.prepareStep', 'opc.mentorTurnStream', 'opc.topicTurn']) {
    expect(procedures).not.toContain(name);
  }
});
