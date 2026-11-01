/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LIBRARY_AGENT_READ_KEY, LIBRARY_RETRIEVAL_KEY } from '../../runtime/libraryAdmission';
import { SKILL_LOAD_REFUSED } from '../../runtime/loadSkillTool';
import { LIBRARY_RETRIEVAL_INSTRUCTIONS, WORKSPACE_CONTEXT_INSTRUCTIONS, WORKSPACE_STRATEGY_INSTRUCTIONS } from '../../runtime/primaryInstructions';
import { OWN_POSTS_INSTRUCTIONS } from '../../runtime/workspacePosts';
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

  it('the workspace keeps read_source offered with the library off, its rules per user, and own posts raise the reads', async () => {
    const posts = { windowDays: 30, benchmarks: false, review: false };
    const setup = await prepare({ library: true, workspace: async () => ({ sources: ['v1'], strategy: true, posts }) });
    expect(setup.plan.available).toContain('read_source');
    expect(setup.context).toMatchObject({ workspaceContext: true });
    expect(setup.context.libraryRetrieval).toBeUndefined();
    expect(setup.sharedInstructions(false)).not.toContain(WORKSPACE_CONTEXT_INSTRUCTIONS);
    for (const text of [WORKSPACE_CONTEXT_INSTRUCTIONS, OWN_POSTS_INSTRUCTIONS]) expect(setup.userInstructions).toContain(text);
    expect(setup.plan.readCalls).toBe(5);
    expect(setup.plan.limits.freeTools).toBe(5);
  });

  it('a free member keeps two reads; a failed workspace check reads nothing and still offers the same tool', async () => {
    const free = await prepare({ workspace: async () => ({ sources: [], strategy: true, posts: { windowDays: 0, benchmarks: false, review: false } }) });
    expect(free.plan.readCalls).toBe(2);
    expect(free.userInstructions).toContain(WORKSPACE_STRATEGY_INSTRUCTIONS);
    const failed = await prepare({ workspace: async () => { throw new Error('db'); } });
    expect(failed.plan.available).toContain('read_source');
    expect(failed.userInstructions).not.toContain(OWN_POSTS_INSTRUCTIONS);
  });

  it('no room for a strategy result: the strategy rule is left out and its read refused', async () => {
    const rows = Object.entries(researchSettings(false)).map(([key, value]) => ({ key, value }));
    const rpc = vi.fn();
    const setup = await prepareChatTools({ admin: {} as SupabaseClient, read: { rpc } as never, configuration: Promise.resolve({ data: rows, error: null }),
      tools: { workspace: async () => ({ sources: ['v1'], strategy: true, posts: null }) }, actorId, sessionId, requiredBytes: 1000,
      interactiveBytes: 50_000, quotedBytes: 150_000, modelMultiplier: '6', defaultMultiplier: '6', maxTools: 9 });
    expect(setup.plan.sourceRoom).toEqual({ strategy: false, posts: false });
    expect(setup.userInstructions).not.toContain(WORKSPACE_STRATEGY_INSTRUCTIONS);
    const tool = (await build(setup as never, false)).tools.find(t => t.name === 'read_source')!;
    expect(JSON.parse(await tool.execute({ query: `strategy_report:${actorId}` }, 'c1'))).toEqual({ kind: 'unavailable' });
    expect(rpc).not.toHaveBeenCalled();
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
