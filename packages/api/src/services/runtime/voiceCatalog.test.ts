/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {clearSkillResourceCache, packageHash, sha256} from '../skills/loader';
import {executionLoadSkillTool, SKILL_LOAD_REFUSED} from './loadSkillTool';
import {admitCatalogVoice, voiceLoader} from './voiceCatalog';
import {frozenVoiceProfile} from './voiceAdmission';
import {voiceAddendum, VOICE_GUIDE, VOICE_HINT_INSTRUCTIONS} from './primaryInstructions';
import {serializedResultBytes, type SkillCatalogEntry} from './skillCatalog';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const profile = {tone: '口语', sentenceLength: '短', openings: '', stance: '', phrases: ['咋整'], avoid: [], platforms: '',
  samples: ['第一段原文', '第二段原文']};
const SKILL = '---\nname: script-writer\ndescription: 用户要写口播稿时使用。\n---\n先问清主题，再写口播稿。\n';
const files = {'SKILL.md': SKILL};
function descriptor() {
  const p = {packageId: id(11), revisionId: id(21), directoryName: 'script-writer', packageHash: '', tasks: {},
    requiredCapabilities: [] as string[], files: Object.entries(files).map(([path, text]) => ({path, bytes: Buffer.byteLength(text),
      sha256: sha256(text), mediaType: 'text/markdown' as const, requires: [] as string[]}))};
  p.packageHash = packageHash(p);
  return p;
}
const entry = (over: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry => ({name: 'script-writer', description: '写口播稿。',
  moduleId: id(1), skillId: id(11), packageId: id(11), revisionId: id(21), packageHash: descriptor().packageHash, resultBytes: 500, ...over});
function toolRpc(saved: unknown = null) {
  return vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'read_skill_package') {
      if (args.p_path === null) return descriptor();
      if (args.p_path === '') return true;
      return Buffer.from(files[args.p_path as keyof typeof files]).toString('base64');
    }
    if (args.p_action === 'claim') return {result: saved};
    return {result: args.p_result};
  }) as unknown as (<T>(name: string, args: Record<string, unknown>) => Promise<T>) & ReturnType<typeof vi.fn>;
}
function admin(options: {flagged?: string[]; current?: unknown; read?: unknown} = {}) {
  return {
    from: () => ({select: () => ({in: async (_: string, ids: string[]) => ({error: null,
      data: ids.map(value => ({id: value, uses_user_voice: (options.flagged ?? []).includes(value)}))})})}),
    rpc: async (name: string) => name === 'voice_profile_current'
      ? {data: options.current ?? {enabled: true, versionId: null, version: null}, error: null}
      : {data: options.read ?? null, error: null},
  } as never;
}
const current = {enabled: true, versionId: id(9), version: 2};
beforeEach(() => clearSkillResourceCache());

describe('admitCatalogVoice', () => {
  it('freezes the confirmed version for the flagged writing Skills of the catalog and reserves what each load adds', async () => {
    const frozen = await admitCatalogVoice(admin({flagged: [id(1), id(3)], current, read: {profile}}), id(5), [id(1), id(2), id(3)], 2);
    const unit = serializedResultBytes(voiceAddendum(profile));
    expect(frozen).toEqual({guide: VOICE_GUIDE, versionId: id(9), version: 2, modules: [id(1), id(3)], reserveBytes: unit * 2});
    expect(frozenVoiceProfile.safeParse(frozen).success).toBe(true);
    expect((await admitCatalogVoice(admin({flagged: [id(1)], current, read: {profile}}), id(5), [id(1), id(2)], 2))?.reserveBytes).toBe(unit);
  });
  it('without a confirmed profile it freezes the one-time hint; with the switch off or no flagged Skill, nothing', async () => {
    const hint = await admitCatalogVoice(admin({flagged: [id(1)]}), id(5), [id(1)], 2);
    expect(hint).toMatchObject({guide: VOICE_GUIDE, modules: [id(1)], reserveBytes: serializedResultBytes(VOICE_HINT_INSTRUCTIONS)});
    expect(hint?.versionId).toBeUndefined();
    expect(await admitCatalogVoice(admin({flagged: [id(1)], current: {enabled: false, versionId: null, version: null}}), id(5), [id(1)], 2)).toBeUndefined();
    expect(await admitCatalogVoice(admin({current, read: {profile}}), id(5), [id(1)], 2)).toBeUndefined();
  });
});

describe('voiceLoader', () => {
  const frozen = frozenVoiceProfile.parse({guide: VOICE_GUIDE, versionId: id(9), version: 2, modules: [id(1)]});
  const database = (read: unknown) => ({rpc: async () => ({data: read, error: null})});
  const actor = async () => id(5);
  it('gives a flagged module the voice text and others nothing', async () => {
    const load = voiceLoader({database: database({profile}), actor}, {voiceProfile: frozen});
    expect(await load(id(1))).toBe(voiceAddendum(profile));
    expect(await load(id(2))).toBeNull();
    expect(await voiceLoader({database: database({profile}), actor}, {})(id(1))).toBeNull();
  });
  it('a bound version that is gone refuses the load for good (Owner: deleted means unusable)', async () => {
    await expect(voiceLoader({database: database(null), actor}, {voiceProfile: frozen})(id(1))).rejects.toThrow('RUNTIME_SKILL_LOAD_DENIED');
  });
  it('with no confirmed profile the load carries the hint', async () => {
    const hint = frozenVoiceProfile.parse({guide: VOICE_GUIDE, modules: [id(1)]});
    expect(await voiceLoader({database: database(null), actor}, {voiceProfile: hint})(id(1))).toBe(VOICE_HINT_INSTRUCTIONS);
  });
});

describe('load_skill appends the voice (the model loads a writing Skill itself)', () => {
  const options = (call: ReturnType<typeof toolRpc>, voiceText: (moduleId: string) => Promise<string | null>) => ({
    executionId: id(9), catalog: [entry()], maxResultBytes: 20000, maxLoads: 2, rpc: call, assertCanStart: () => {}, voiceText});
  it('after the journaled result: the journal holds the Skill only, never the voice', async () => {
    const call = toolRpc();
    const tool = executionLoadSkillTool(options(call, async moduleId => moduleId === id(1) ? '\n[VOICE]' : null));
    const result = JSON.parse(await tool.execute({name: 'script-writer'}, 'c1'));
    expect(result.instructions).toMatch(/先问清主题[\s\S]*\n\[VOICE\]$/);
    const complete = call.mock.calls.find(([name, args]) => name === 'runtime_tool' && args.p_action === 'complete')!;
    expect(JSON.stringify(complete[1].p_result)).not.toContain('VOICE');
  });
  it('a replay returns the same bytes: the journaled Skill plus the voice read again', async () => {
    const saved = {name: 'script-writer', moduleId: id(1), packageId: id(11), revisionId: id(21), packageHash: descriptor().packageHash,
      instructions: '已保存的说明'};
    const tool = executionLoadSkillTool(options(toolRpc(saved), async () => '\n[VOICE]'));
    expect(JSON.parse(await tool.execute({name: 'script-writer'}, 'c1'))).toEqual({...saved, instructions: '已保存的说明\n[VOICE]'});
  });
  it('a Skill that does not use the voice loads unchanged', async () => {
    const plain = executionLoadSkillTool({executionId: id(9), catalog: [entry()], maxResultBytes: 20000, maxLoads: 2, rpc: toolRpc(),
      assertCanStart: () => {}});
    const tool = executionLoadSkillTool(options(toolRpc(), async () => null));
    expect(await tool.execute({name: 'script-writer'}, 'c1')).toBe(await plain.execute({name: 'script-writer'}, 'c1'));
  });
  it('a deleted voice refuses the load: the model is told to answer without the Skill', async () => {
    const onRefused = vi.fn();
    const tool = executionLoadSkillTool({...options(toolRpc(), async () => { throw new Error('RUNTIME_SKILL_LOAD_DENIED'); }), onRefused});
    expect(await tool.execute({name: 'script-writer'}, 'c1')).toBe(SKILL_LOAD_REFUSED);
    expect(onRefused).toHaveBeenCalledTimes(1);
  });
});
