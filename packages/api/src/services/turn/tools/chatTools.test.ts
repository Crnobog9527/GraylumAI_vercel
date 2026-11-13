/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LIBRARY_AGENT_READ_KEY, LIBRARY_RETRIEVAL_KEY } from '../admission/libraryAdmission';
import { SKILL_LOAD_REFUSED } from '../skills/loadSkillTool';
import { LIBRARY_RETRIEVAL_INSTRUCTIONS, WORKSPACE_CONTEXT_INSTRUCTIONS, WORKSPACE_STRATEGY_INSTRUCTIONS } from '../agent/primaryInstructions';
import { OWN_POSTS_INSTRUCTIONS } from '../agent/workspacePosts';
import { prepareChatTools, type ChatToolDeps } from './chatTools';
import { freeSlots, researchSettings } from './__tests__/fixtures';

const actorId = '00000000-0000-4000-8000-000000000001', sessionId = '00000000-0000-4000-8000-000000000002';
const hash = 'a'.repeat(64);
const entry = (name: string, extra = {}) => ({ name, description: `${name} method`, moduleId: actorId, skillId: actorId, packageId: name,
  revisionId: actorId, packageHash: hash, resultBytes: 10, ...extra });
const catalog = [entry('Hooks', { social: true as const }), entry('Pricing', { usesVoice: true as const, title: '定价方案' })];
const skills = async () => ({ catalog, prepared: new Map([['Hooks', 'hooks text'], ['Pricing', 'pricing text']]) });

function prepare(tools: ChatToolDeps & { currentMessage?: string }, switches: Record<string, unknown> = {}) {
  const rows = Object.entries({ ...researchSettings(false), ...switches }).map(([key, value]) => ({ key, value }));
  const { currentMessage, ...deps } = tools;
  return prepareChatTools({ admin: {} as SupabaseClient, read: { rpc: vi.fn() } as never, configuration: Promise.resolve({ data: rows, error: null }),
    tools: deps, actorId, sessionId, ...(currentMessage === undefined ? {} : { currentMessage }), requiredBytes: 1000, interactiveBytes: 90_000, quotedBytes: 150_000, modelMultiplier: '6', defaultMultiplier: '6', maxTools: 9 });
}
const build = (setup: Awaited<ReturnType<typeof prepare>>, gated: boolean) => setup.build({} as never, { slots: freeSlots, currentMessage: 'x',
  deadline: Date.now() + 1000, callGate: async () => {}, onStop: () => {}, gated, onCall: { emit: () => {}, q: '100' } });
const load = async (setup: Awaited<ReturnType<typeof prepare>>, gated: boolean, name: string) =>
  (await build(setup, gated)).tools.find(tool => tool.name === 'load_skill')!.execute({ name }, 'c1');

describe('a free chat\'s tools from the route\'s dependencies (CORE-PATH-V2 V2-6)', () => {
  it('each tool announces its start and its end under one id, and a refused Skill is not named', async () => {
    const setup = await prepare({ skills });
    const events: unknown[] = [];
    const built = await setup.build({} as never, { slots: freeSlots, currentMessage: 'x', deadline: Date.now() + 1000, callGate: async () => {},
      onStop: () => {}, gated: true, onCall: { emit: () => {}, q: '100' }, announce: event => events.push(event) });
    const run = (name: string, args: Record<string, unknown>) => built.tools.find(tool => tool.name === name)!.execute(args, 'c1');
    await run('load_skill', { name: 'Pricing' });
    // Hooks is a social-media Skill: this account may not load it, so the page is not told its name and the step is skipped.
    await run('load_skill', { name: 'Hooks' });
    expect(events).toEqual([
      // LOAD-SKILL: named by its display title (the menu name), never by the name the model calls.
      { type: 'step', id: '1', tool: 'load_skill', label: '定价方案', state: 'running' },
      { type: 'step', id: '1', tool: 'load_skill', label: '定价方案', state: 'done' },
      { type: 'step', id: '2', tool: 'load_skill', state: 'running' },
      { type: 'step', id: '2', tool: 'load_skill', state: 'skipped' }]);
  });

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
    expect(voice).toHaveBeenCalledWith(actorId, catalog, '');
    expect(setup.userInstructions).toBe('\nWriting voice');
    expect(setup.voiceVersionId).toBe('v1');
    expect(setup.sharedInstructions(false)).not.toContain('Writing voice');
  });

  // VOICE-2 PR-2: the examples go with the current message (the plan's note), sized, never into either instruction segment.
  it('the voice examples ride with the current message, not the instructions', async () => {
    const voice = vi.fn(async () => ({ text: '\nWriting voice', versionId: 'v1', examples: '\n<user_voice_examples>x</user_voice_examples>' }));
    const setup = await prepare({ skills, voice, currentMessage: '帮我写一条小红书' });
    expect(voice).toHaveBeenCalledWith(actorId, catalog, '帮我写一条小红书');
    expect(setup.plan.note).toContain('<user_voice_examples>x</user_voice_examples>');
    expect(setup.userInstructions).toBe('\nWriting voice');
    expect(setup.sharedInstructions(false)).not.toContain('user_voice_examples');
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
    expect(setup.selection({ moduleId: actorId })).toEqual({ note: expect.stringContaining('"Hooks"'),
      skill: { moduleId: actorId, skillId: actorId, revisionId: catalog[0]!.revisionId }, social: true });
    // The social-media mark is only on a social-media Skill (chat.ts refuses it for an account without a confirmed positioning).
    const plain = await prepare({ skills: async () => ({ catalog: [catalog[1]!], prepared: new Map([['Pricing', 'pricing text']]) }) });
    expect(plain.selection({ moduleId: actorId })).not.toHaveProperty('social');
    expect(setup.selection({ moduleId: sessionId })).toEqual({ refused: 'TURN_SKILL_UNAVAILABLE' });
    expect(setup.selection({ references: [{ documentId: sessionId, version: 1 }] })).toEqual({ refused: 'TURN_REFERENCES_UNAVAILABLE' });
    expect(setup.selection({})).toEqual({ note: '' });
    const off = await prepare({});
    expect(off.selection({ moduleId: actorId })).toEqual({ refused: 'TURN_SKILL_UNAVAILABLE' });
  });

  it('the Skill list and the workspace access are read together, and a failed workspace read leaves the Skills', async () => {
    const started: string[] = [];
    let releaseSkills!: () => void;
    const slowSkills = () => new Promise<Awaited<ReturnType<typeof skills>>>(resolve => {
      started.push('skills'); releaseSkills = () => resolve({ catalog, prepared: new Map([['Hooks', 'hooks text']]) });
    });
    const pending = prepare({ skills: slowSkills, workspace: async () => { started.push('workspace'); return { sources: ['v1'], strategy: true, posts: null }; } });
    await new Promise(resolve => setTimeout(resolve, 0));
    // The workspace was asked while the Skill list was still being read.
    expect(started).toEqual(['skills', 'workspace']);
    releaseSkills();
    const setup = await pending;
    expect(setup.plan.available).toEqual(expect.arrayContaining(['load_skill', 'read_source']));
    const broken = await prepare({ skills, workspace: async () => { throw new Error('TURN_WORKSPACE_UNAVAILABLE'); } });
    expect(broken.plan.available).toContain('load_skill');
  });
});

describe('INTEGRATION-SHOTVIVA: the image tools of a free chat', () => {
  const images = (ready: true | 'not_entitled' | 'not_linked' | 'disabled', generate = vi.fn()) => ({ ready: vi.fn(async () => ready),
    calls: vi.fn((_actor: string, session: string) => ({ sessionId: session, listTemplates: vi.fn(), generate })) });

  it('offered only where the deployment has the connector; the same definitions whether or not this account may use them', async () => {
    expect((await prepare({ skills })).plan.offered).not.toContain('generate_image');
    const usable = await prepare({ skills, images: images(true) });
    const free = await prepare({ skills, images: images('not_entitled') });
    expect(usable.plan.offered).toEqual(free.plan.offered);
    expect(usable.plan.offered).toEqual(expect.arrayContaining(['list_image_templates', 'generate_image']));
    expect(usable.context.imageGeneration).toBe(true);
    expect(usable.definitionBytes).toBe(free.definitionBytes);
    expect(usable.sharedInstructions(false)).toBe(free.sharedInstructions(false));
    expect(usable.plan.available).toContain('generate_image');
    expect(free.plan.trimmed).toContainEqual({ name: 'generate_image', reason: 'not_entitled' });
  });

  it('builds the image tools bound to this account and session; a failed readiness check trims them', async () => {
    const generate = vi.fn(async () => ({ status: 'failed' as const, code: 'quota_exhausted' as const, topUpUrl: null, jobId: null, refunded: false }));
    const deps = images(true, generate);
    const setup = await prepare({ skills, images: deps });
    const built = await build(setup, false);
    const tool = built.tools.find(item => item.name === 'generate_image')!;
    expect(JSON.parse(await tool.execute({ template_id: 'freeform', prompt: 'a cup' }, 'call-1'))).toMatchObject({ code: 'quota_exhausted' });
    expect(deps.calls).toHaveBeenCalledWith(actorId, sessionId, { turnId: undefined, kept: null });
    // This message's photos as they are kept, with its turn: a photo sent now can be used now (Owner 2026-11-13).
    const kept = Promise.resolve([{ path: 'p', turnId: 42, index: 0 }]);
    await setup.build({ turnId: 42 } as never, { slots: freeSlots, currentMessage: 'x', deadline: Date.now() + 1000, callGate: async () => {},
      onStop: () => {}, gated: false, onCall: { emit: () => {}, q: '100' }, photos: kept });
    expect(deps.calls).toHaveBeenLastCalledWith(actorId, sessionId, { turnId: 42, kept });
    const broken = await prepare({ skills, images: { ready: vi.fn(async () => { throw new Error('down'); }), calls: vi.fn() } });
    expect(broken.plan.trimmed).toContainEqual({ name: 'generate_image', reason: 'disabled' });
  });
});
