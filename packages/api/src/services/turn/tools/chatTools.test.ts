/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LIBRARY_AGENT_READ_KEY, LIBRARY_RETRIEVAL_KEY } from '../../runtime/libraryAdmission';
import { SKILL_LOAD_REFUSED } from '../../runtime/loadSkillTool';
import { LIBRARY_RETRIEVAL_INSTRUCTIONS } from '../../runtime/primaryInstructions';
import { prepareChatTools, type ChatToolDeps } from './chatTools';
import { freeSlots, researchSettings } from './__tests__/fixtures';

const actorId = '00000000-0000-4000-8000-000000000001', sessionId = '00000000-0000-4000-8000-000000000002';
const hash = 'a'.repeat(64);
const entry = (name: string, extra = {}) => ({ name, description: `${name} method`, moduleId: actorId, skillId: actorId, packageId: name,
  revisionId: actorId, packageHash: hash, resultBytes: 10, ...extra });
const catalog = [entry('Hooks', { social: true as const }), entry('Pricing', { usesVoice: true as const })];
const skills = async () => ({ catalog, prepared: new Map([['Hooks', 'hooks text'], ['Pricing', 'pricing text']]) });

function prepare(tools: ChatToolDeps, switches: Record<string, unknown> = {}) {
  const rows = Object.entries({ ...researchSettings(false), ...switches }).map(([key, value]) => ({ key, value }));
  return prepareChatTools({ admin: {} as SupabaseClient, read: { rpc: vi.fn() } as never, configuration: Promise.resolve({ data: rows, error: null }),
    tools, actorId, sessionId, requiredBytes: 1000, interactiveBytes: 90_000, quotedBytes: 150_000, modelMultiplier: '6', defaultMultiplier: '6', maxTools: 9 });
}
const build = (setup: Awaited<ReturnType<typeof prepare>>, gated: boolean) => setup.build({} as never, { slots: freeSlots, currentMessage: 'x',
  deadline: Date.now() + 1000, callGate: async () => {}, onStop: () => {}, gated, onCall: { emit: () => {}, q: '100' } });
const load = async (setup: Awaited<ReturnType<typeof prepare>>, gated: boolean, name: string) =>
  (await build(setup, gated)).tools.find(tool => tool.name === 'load_skill')!.execute({ name }, 'c1');

describe('a free chat\'s tools from the route\'s dependencies (CORE-PATH-V2 V2-6)', () => {
  it('an account with a confirmed positioning sees and loads every Skill', async () => {
    const setup = await prepare({ skills });
    expect(setup.plan.available).toContain('load_skill');
    expect(setup.sharedInstructions(false)).toContain('Hooks');
    expect(await load(setup, false, 'Hooks')).toBe('hooks text');
  });

  it('refused: an account without one neither sees nor loads a social-media Skill', async () => {
    const setup = await prepare({ skills });
    expect(setup.sharedInstructions(true)).not.toContain('Hooks');
    expect(setup.sharedInstructions(true)).toContain('Pricing');
    expect(await load(setup, true, 'Pricing')).toBe('pricing text');
    expect(await load(setup, true, 'Hooks')).toBe(SKILL_LOAD_REFUSED);
  });

  it('read_source is offered only while both library switches are on, with its instructions', async () => {
    const on = await prepare({ library: true }, { [LIBRARY_AGENT_READ_KEY]: true, [LIBRARY_RETRIEVAL_KEY]: true });
    expect(on.plan.available).toContain('read_source');
    expect(on.sharedInstructions(false)).toContain(LIBRARY_RETRIEVAL_INSTRUCTIONS);
    const off = await prepare({ library: true }, { [LIBRARY_AGENT_READ_KEY]: true, [LIBRARY_RETRIEVAL_KEY]: false });
    expect(off.plan.offered).not.toContain('read_source');
    expect(off.sharedInstructions(false)).not.toContain(LIBRARY_RETRIEVAL_INSTRUCTIONS);
  });

  it('the catalog voice goes to the per-user segment with its version, never the shared one', async () => {
    const voice = vi.fn(async () => ({ text: '\nWriting voice', versionId: 'v1' }));
    const setup = await prepare({ skills, voice });
    expect(voice).toHaveBeenCalledWith(actorId, catalog);
    expect(setup.userInstructions).toBe('\nWriting voice');
    expect(setup.voiceVersionId).toBe('v1');
    expect(setup.sharedInstructions(false)).not.toContain('Writing voice');
  });

  it('a voice that cannot be read leaves the turn without it; no catalog means no voice read', async () => {
    const setup = await prepare({ skills, voice: async () => { throw new Error('down'); } });
    expect(setup.userInstructions).toBe('');
    expect(setup.voiceVersionId).toBeUndefined();
    const voice = vi.fn();
    await prepare({ voice });
    expect(voice).not.toHaveBeenCalled();
  });

  it('a chosen Skill or attached document is one line for the model, or a refusal before anything opens (V2-10)', async () => {
    const setup = await prepare({ skills });
    expect(setup.selection({ moduleId: actorId })).toEqual({ note: expect.stringContaining('"Hooks"') });
    expect(setup.selection({ moduleId: sessionId })).toEqual({ refused: 'TURN_SKILL_UNAVAILABLE' });
    expect(setup.selection({ references: [{ documentId: sessionId, version: 1 }] })).toEqual({ refused: 'TURN_REFERENCES_UNAVAILABLE' });
    expect(setup.selection({})).toEqual({ note: '' });
    const off = await prepare({});
    expect(off.selection({ moduleId: actorId })).toEqual({ refused: 'TURN_SKILL_UNAVAILABLE' });
  });
});
