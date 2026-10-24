/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {admitCatalogVoice, withVoice} from './voiceCatalog';
import {frozenVoiceProfile} from './voiceAdmission';
import {voiceAddendum, VOICE_GUIDE, VOICE_HINT_INSTRUCTIONS} from './primaryInstructions';
import type {SkillCatalogEntry} from './skillCatalog';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const profile = {tone: '口语', sentenceLength: '短', openings: '', stance: '', phrases: ['咋整'], avoid: [], platforms: '',
  samples: ['第一段原文', '第二段原文']};
const entry = (n: number, name: string, usesVoice = false): SkillCatalogEntry => ({name, description: '', moduleId: id(n), skillId: id(10 + n),
  packageId: id(20 + n), revisionId: id(30 + n), packageHash: 'a'.repeat(64), resultBytes: 500, ...(usesVoice ? {usesVoice: true as const} : {})});
const catalog = [entry(1, 'script-writer', true), entry(2, 'general-helper'), entry(3, 'post-writer', true)];
const strip = (item: SkillCatalogEntry): SkillCatalogEntry => { const copy = {...item}; delete copy.usesVoice; return copy; };
const withoutVoice = catalog.map(strip);
const flaggedOnly = (...ids: number[]) => catalog.map(item => ids.some(n => id(n) === item.moduleId) ? {...strip(item), usesVoice: true as const} : strip(item));
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

describe('admitCatalogVoice', () => {
  it('names the flagged writing Skills of the catalog in the frozen voice and gives the paragraph it will add', async () => {
    const voice = await admitCatalogVoice(admin({flagged: [id(1), id(3)], current, read: {profile}}), id(5), catalog);
    expect(voice?.frozen).toEqual({guide: VOICE_GUIDE, versionId: id(9), version: 2, modules: [id(1), id(3)]});
    expect(frozenVoiceProfile.safeParse(voice?.frozen).success).toBe(true);
    expect(voice?.text).toContain(voiceAddendum(profile));
    expect(voice?.text).toContain('after loading one of these Skills: script-writer, post-writer');
    expect(voice?.text).not.toContain('general-helper');
  });
  it('without a confirmed profile it carries the one-time hint, still only for the flagged Skills', async () => {
    const voice = await admitCatalogVoice(admin({flagged: [id(1)]}), id(5), flaggedOnly(1));
    expect(voice?.frozen.versionId).toBeUndefined();
    expect(voice?.text).toContain(VOICE_HINT_INSTRUCTIONS);
    expect(voice?.text).toContain('after loading one of these Skills: script-writer.');
  });
  it('no flagged Skill: no database call at all (a catalog without the voice costs no extra round trip)', async () => {
    const calls: string[] = [];
    const spy = {from: () => { calls.push('from'); throw new Error('no module read'); }, rpc: async (name: string) => { calls.push(name); return {data: null, error: null}; }} as never;
    expect(await admitCatalogVoice(spy, id(5), withoutVoice)).toBeUndefined();
    expect(calls).toEqual([]);
  });
  it('switched off, or no flagged Skill: nothing', async () => {
    expect(await admitCatalogVoice(admin({flagged: [id(1)], current: {enabled: false, versionId: null, version: null}}), id(5), catalog)).toBeUndefined();
    expect(await admitCatalogVoice(admin({current, read: {profile}}), id(5), withoutVoice)).toBeUndefined();
  });
});

describe('withVoice (free chat with a Skill catalog)', () => {
  const frozen = frozenVoiceProfile.parse({guide: VOICE_GUIDE, versionId: id(9), version: 2, modules: [id(1), id(3)]});
  const options = (read: unknown) => ({database: {rpc: async () => ({data: read, error: null})}, actor: async () => id(5)});
  const context = {voiceProfile: frozen, skillCatalog: catalog};
  it('appends the voice once as a system paragraph, bound to the flagged Skills only', async () => {
    const text = await withVoice(options({profile}), 'BASE', context, undefined);
    expect(text).toBe('BASE' + voiceAddendum(profile) + '\nApply this writing voice only to content you write after loading one of these Skills: '
      + 'script-writer, post-writer. For every other reply, ignore it completely. Before writing the first line of such content, make sure no '
      + "sentence repeats earlier wording of the user or a stock line from the description above: the opening and first three sentences must be new, "
      + 'about the current topic.');
  });
  it('an execution frozen with voice-v2 replays the earlier guard, without the closing reminder', async () => {
    const old = frozenVoiceProfile.parse({guide: 'voice-v2', versionId: id(9), version: 2, modules: [id(1), id(3)]});
    const text = await withVoice(options({profile}), 'BASE', {voiceProfile: old, skillCatalog: catalog}, undefined);
    expect(text.endsWith('script-writer, post-writer. For every other reply, ignore it completely.')).toBe(true);
  });
  it('a bound version that is gone ends the run before any provider request (Owner: deleted means unusable)', async () => {
    await expect(withVoice(options(null), 'BASE', context, undefined)).rejects.toThrow('VOICE_SOURCE_DELETED');
  });
  it('with no confirmed profile it adds the guarded hint', async () => {
    const hint = frozenVoiceProfile.parse({guide: VOICE_GUIDE, modules: [id(1)]});
    const text = await withVoice(options(null), 'BASE', {voiceProfile: hint, skillCatalog: catalog}, undefined);
    expect(text).toContain(VOICE_HINT_INSTRUCTIONS);
    expect(text).toContain('after loading one of these Skills: script-writer.');
  });
  it('changes nothing without a catalog voice, and leaves a chosen or matched Skill to withExecutionVoice', async () => {
    expect(await withVoice(options({profile}), 'BASE', {}, undefined)).toBe('BASE');
    expect(await withVoice(options({profile}), 'BASE', {voiceProfile: frozen}, undefined)).toBe('BASE');
    expect(await withVoice(options({profile}), 'BASE', context, id(2))).toBe('BASE');
  });
});
