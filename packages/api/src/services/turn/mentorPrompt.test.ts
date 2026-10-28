/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_IDENTITY_INSTRUCTIONS } from '../modelIdentity/brandIdentity';
import { clearSkillResourceCache, packageHash, sha256 } from '../skills/loader';
import { GROUNDED_CARD_CONTRACT } from '../runtime/groundedCard';
import { HOST_TURN_DATA_NOTICE_V1, type HostTurnContext } from '../runtime/hostTurn';
import { AGENT_TURN_REQUEST_FORMAT, openRouterRequestBody, type RequestContext } from '../runtime/providerRequest';
import { freezeSharedPromptCache } from '../runtime/promptCache';
import { replySettingInstructions } from '../runtime/replyLanguage';
import { openRouterBound } from '../bill2/openRouterPolicy';
import { mentorSystem, mentorUserMessage, projectMentorHistory, SKILL_FILE_INSTRUCTIONS } from './mentorPrompt';
import { loadMentorSkill, mentorSkillFileTool, mentorSkillSource, skillEntryChars } from './mentorSkill';

/*
 * CORE-PATH-V2 V2-5 golden bytes (plan 2.9; #1502 rewritten for the turn path): the mentor request's three cache breakpoints,
 * what each covers, and that changing step, user or turn never changes the bytes of the shared first block.
 */
const skillId = '00000000-0000-4000-8000-0000000000b1', revisionId = '00000000-0000-4000-8000-0000000000c1';
const files: Record<string, string> = { 'SKILL.md': '---\nname: positioning\ndescription: Demo.\n---\nShared method body\n',
  'step-1.md': 'Step one guide\n', 'step-2.md': 'Step two guide\n', 'templates/card.md': 'A declared file\n' };
const manifest = () => {
  const list = Object.entries(files).map(([path, body]) => ({ path, bytes: Buffer.byteLength(body), sha256: sha256(body),
    mediaType: 'text/markdown' as const, requires: [] as string[] }));
  const p = { packageId: skillId, revisionId, directoryName: 'positioning', packageHash: '', tasks: {}, requiredCapabilities: [], files: list };
  p.packageHash = packageHash(p);
  return p;
};
const rpc = vi.fn(async (_name: string, args: { p_path: string | null; p_paths?: string[] }) => args.p_paths
  ? { data: { files: Object.fromEntries(args.p_paths.map(path => [path, Buffer.from(files[path]!).toString('base64')])) }, error: null }
  : { data: args.p_path === null ? manifest() : Buffer.from(files[args.p_path]!).toString('base64'), error: null });
const admin = { rpc } as unknown as SupabaseClient;
const skill = () => mentorSkillSource(admin, { actorId: 'actor', moduleId: 'module', skillId, revisionId, packageHash: manifest().packageHash });
const host = (stepId: string, opening = false, value = ''): HostTurnContext => ({ cardContract: GROUNDED_CARD_CONTRACT, stepId, opening,
  confirmation: { requiredComplete: false, stepConfirmed: false, stepReady: false, needsLookFieldIds: [] },
  checklist: [{ id: stepId, title: 'Step', fields: [{ id: 'audience', title: 'Audience', required: true, role: 'user_fact',
    status: value ? 'draft' : 'missing', protected: false, value, nature: 'unknown', source: 'unknown', basis: 'unknown',
    hasPendingSuggestion: false }] }] });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function request(input: { stepId: string; locale?: 'zh-Hans' | 'en'; opening?: boolean; history?: boolean; value?: string }) {
  const { source, binding } = skill();
  const loaded = await loadMentorSkill(source, binding, [input.stepId + '.md'], 90000);
  const h = host(input.stepId, input.opening ?? false, input.value);
  const system = mentorSystem({ skillText: loaded.text, skillEntryChars: loaded.entryChars, brandIdentity: true, mode: 'mentor', host: h,
    skillFile: !input.opening, replyRule: replySettingInstructions(input.locale ?? 'zh-Hans') });
  const promptCache = freezeSharedPromptCache({ real: true, model: 'anthropic/claude-sonnet-5.5', cacheWriteUsdPerMillion: '3.75',
    instructions: system.instructions, prefixChars: system.prefixChars, historyMarker: !input.opening })!;
  const user = mentorUserMessage(input.opening ? 'HOST_OPEN_CURRENT_QUESTION' : 'I sell coffee', { content: {} }, h);
  const tools = ['ask_question', 'read_skill_file'].map(name => ({ type: 'function', function: { name, parameters: {} } }));
  const messages = [{ role: 'system', content: system.instructions },
    ...(input.history ? [{ role: 'user', content: 'Earlier words' }, { role: 'assistant', content: 'Earlier reply' }] : []),
    { role: 'user', content: user }];
  const providerLimits = { providerSlug: 'anthropic', contextTokens: 200000, promptUsdPerMillion: '3', completionUsdPerMillion: '15',
    requestUsd: '0', cacheWriteUsdPerMillion: '3.75' };
  const policy = { model: 'anthropic/claude-sonnet-5.5', providerLimits, outputLimit: 1000, upperUsd: openRouterBound(providerLimits, 1000).upperUsd };
  const context: RequestContext = { providerRequestFormat: AGENT_TURN_REQUEST_FORMAT, tools: ['ask_question', 'read_skill_file'],
    network: 'deny', reasoning: { effort: 'none' } as never, hostTurnContext: { opening: Boolean(input.opening) }, promptCache };
  const body = JSON.parse(openRouterRequestBody(JSON.stringify({ model: policy.model, messages, tools, stream: true,
    stream_options: { include_usage: true }, store: false, max_tokens: 1000, reasoning_effort: 'none' }),
  { context, policy: policy as never, phase: 'ordinary', primaryDialogue: true }));
  return { body, system, loaded };
}
const blocks = (body: { messages: Array<{ content: unknown }> }) => body.messages[0]!.content as Array<{ text: string; cache_control?: unknown }>;
const markers = (value: unknown) => (JSON.stringify(value).match(/cache_control/g) ?? []).length;

beforeEach(() => { clearSkillResourceCache(); rpc.mockClear(); });

describe('mentor prompt cache breakpoints (CORE-PATH-V2 2.9, #1502)', () => {
  it('breakpoint 1 ends exactly after brand + SKILL.md and is byte-identical for every step, user and turn', async () => {
    const one = await request({ stepId: 'step-1', history: true });
    const two = await request({ stepId: 'step-2', locale: 'en', history: true, value: 'coffee lovers' });
    const opening = await request({ stepId: 'step-2', opening: true });
    const first = blocks(one.body)[0]!;
    // The exact shared bytes: the brand text, then the Skill JSON up to the end of the SKILL.md section.
    expect(first.text).toBe(BRAND_IDENTITY_INSTRUCTIONS + '\n' + JSON.stringify({ skill: { packageId: skillId, revisionId,
      packageHash: manifest().packageHash }, resources: [{ path: 'SKILL.md', content: files['SKILL.md'] }] }).slice(0, -2));
    expect(first.cache_control).toEqual({ type: 'ephemeral' });
    // Changing step, reply language, checklist values or opening never changes the first block's hash.
    for (const other of [two, opening]) expect(hash(blocks(other.body)[0]!.text)).toBe(hash(first.text));
    expect(first.text).not.toContain('Step one guide');
  });

  it('breakpoint 2 covers the rest of the system message (step resources, fixed rules, reply language), never per-turn state', async () => {
    const { body, system } = await request({ stepId: 'step-1', history: true, value: 'coffee lovers' });
    const [first, second] = blocks(body);
    expect(first!.text + second!.text).toBe(system.instructions);
    expect(second!.cache_control).toEqual({ type: 'ephemeral' });
    expect(second!.text).toContain('Step one guide');
    expect(second!.text.endsWith(replySettingInstructions('zh-Hans'))).toBe(true);
    expect(second!.text).toContain(SKILL_FILE_INSTRUCTIONS);
    // The checklist, its values and the user's words are only in the current user message, which carries no marker.
    expect(system.instructions).not.toContain('coffee lovers');
    const current = body.messages.at(-1);
    expect(current.content).toContain('coffee lovers');
    expect(JSON.parse(current.content)).toMatchObject({ inputFormat: 'host-turn-v1', userRequest: 'I sell coffee',
      dataNotice: HOST_TURN_DATA_NOTICE_V1 });
  });

  it('breakpoint 3 is the last plain history message; three markers in all; an opening has no history marker', async () => {
    const { body } = await request({ stepId: 'step-1', history: true });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Earlier reply', cache_control: { type: 'ephemeral' } }] });
    expect(markers(body)).toBe(3);
    const opening = await request({ stepId: 'step-1', opening: true, history: true });
    expect(markers(opening.body)).toBe(2);
    // An opening offers the same tools as the turns after it (same cached prefix) but may not call them.
    expect(opening.body.tool_choice).toBe('none');
    expect(opening.body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['ask_question', 'read_skill_file']);
    expect(blocks(opening.body)[1]!.text).not.toContain(SKILL_FILE_INSTRUCTIONS);
  });

  it('a Skill text without a SKILL.md section boundary marks nothing', () => {
    expect(skillEntryChars('not json', { packageId: skillId, revisionId, packageHash: 'a'.repeat(64) })).toBe(0);
    expect(mentorSystem({ skillText: 'x', skillEntryChars: 0, brandIdentity: true, mode: 'mentor', host: host('step-1'),
      skillFile: true, replyRule: '' }).prefixChars).toBe(0);
  });
});

describe('mentor Skill package from the process cache (plan 2.4, 2.7)', () => {
  it('a warm cache loads the step text and answers read_skill_file without any database read', async () => {
    await request({ stepId: 'step-1' });
    expect(rpc).toHaveBeenCalledTimes(2); // cold: the listing and one batch of the needed files
    rpc.mockClear();
    const { source, binding } = skill();
    const loaded = await loadMentorSkill(source, binding, ['step-1.md'], 90000);
    expect(loaded.text).toContain('Step one guide');
    // The declared file not yet read is the only database read; reading it again is free.
    const tool = mentorSkillFileTool(source, binding);
    expect(JSON.parse(await tool.execute({ path: 'templates/card.md' }, 'call-1')).content).toBe('A declared file\n');
    const before = rpc.mock.calls.length;
    await tool.execute({ path: 'templates/card.md' }, 'call-2');
    await loadMentorSkill(source, binding, ['step-1.md'], 90000);
    expect(rpc.mock.calls.length).toBe(before);
    expect(before).toBeLessThanOrEqual(1);
  });

  it('refuses any other package identity', async () => {
    const { source } = skill();
    expect(await source.state({ packageId: skillId, revisionId, packageHash: 'b'.repeat(64) })).toBe('denied');
  });
});

describe('mentor history projection (plan 2.9 rule 5)', () => {
  it('a saved reply is shown to the model as the text the user saw, derived from that message alone', () => {
    const body = JSON.stringify({ format: 'agent-turn.v1', message: 'Visible reply', card: null });
    const item = (role: 'user' | 'assistant', content: string, seq: number) => ({ seq, role, content, contentHash: 'a'.repeat(64) });
    expect(projectMentorHistory([item('user', 'Hi', 1), item('assistant', body, 2)]).map(m => m.content)).toEqual(['Hi', 'Visible reply']);
  });
});

describe('mentor prompt cache eligibility (hostTurnAdmission.test.ts, migrated)', () => {
  it('no breakpoint without a cache write price or on a non-Anthropic model; the host structure is unchanged', () => {
    const base = { real: true, instructions: 'brand+skill rest', prefixChars: 11, historyMarker: true };
    expect(freezeSharedPromptCache({ ...base, model: 'anthropic/claude-sonnet-5.5', cacheWriteUsdPerMillion: undefined })).toBeUndefined();
    expect(freezeSharedPromptCache({ ...base, model: 'google/gemini-test', cacheWriteUsdPerMillion: '1' })).toBeUndefined();
    expect(freezeSharedPromptCache({ ...base, model: 'anthropic/claude-sonnet-5.5', cacheWriteUsdPerMillion: '3.75' }))
      .toMatchObject({ version: 'prompt-cache-v3', systemPrefixChars: 11, historyMarker: true });
  });
});
