/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withInjectedSource } from './contentSource';
import { fittingCandidates, matchCandidate, type MatchCandidate } from './matching';

describe('A2 injected content source', () => {
  it('puts the body only into the instructions of the call it is built for', () => {
    const instructions = withInjectedSource('SKILL', 'script', 2, 'SCRIPT_BODY_CANARY');
    expect(instructions.startsWith('SKILL\n')).toBe(true);
    expect(instructions).toContain('version 2');
    expect(instructions.endsWith('SCRIPT_BODY_CANARY')).toBe(true);
  });
});

describe('A2 matching plan', () => {
  const candidate = (key: number): MatchCandidate => matchCandidate.parse({ key: 'candidate-' + key, name: 'Skill ' + key, description: '',
    moduleId: randomUUID(), skillId: randomUUID(), packageId: 'p', revisionId: randomUUID(), packageHash: 'a'.repeat(64),
    modelId: randomUUID(), model: 'm', inputLimit: 100000, outputLimit: 100, requiresTask: false });
  it('freezes each kept candidate\'s declared content source; older plans without it still parse', async () => {
    const [plain, storyboard] = [candidate(0), candidate(1)];
    const kept = await fittingCandidates([plain, storyboard],
      async c => c === storyboard ? { instructions: 'SKILL', contentSource: 'script' } : 'SKILL',
      { input: 'hi', inputBytes: 100000, toolBytes: 0, instructions: skill => skill });
    expect(kept.map(c => c.contentSource)).toEqual([undefined, 'script']);
    expect(matchCandidate.parse(kept[1]).contentSource).toBe('script');
    expect(() => matchCandidate.parse({ ...plain, contentSource: 'editing' })).toThrow();
  });
});
