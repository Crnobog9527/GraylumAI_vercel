/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {SkillCatalogEntry} from './skillCatalog';

const mocks = vi.hoisted(() => ({catalog: [] as unknown[], voice: undefined as unknown}));
vi.mock('./skillCatalog', async importOriginal => ({...await importOriginal<object>(), discoverSkillCatalog: async () => mocks.catalog}));
vi.mock('./voiceCatalog', () => ({admitCatalogVoice: async () => mocks.voice}));
import {admitSkillCatalog} from './skillCatalogAdmission';
import {serializedResultBytes, skillCatalogReserveBytes} from './skillCatalog';
import {loadSkillToolBytes} from './loadSkillTool';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const entry: SkillCatalogEntry = {name: 'script-writer', description: '写口播稿。', moduleId: id(1), skillId: id(11), packageId: id(21),
  revisionId: id(31), packageHash: 'a'.repeat(64), resultBytes: 500, usesVoice: true};
const voice = {frozen: {guide: 'voice-v2' as const, versionId: id(9), version: 2, modules: [id(1)]}, text: '\n\nWriting voice (host rule): 样例'};
const run = (fits: (extra: number, text: string) => boolean) => admitSkillCatalog({} as never, {} as never, {eligible: true, excludeSocial: false,
  actor: async () => id(5), inputLimit: 100000, maxCalls: 3, fitsWith: fits});
beforeEach(() => { mocks.catalog = [entry]; mocks.voice = voice; });

describe('admitSkillCatalog with the voice', () => {
  it('returns the voice bytes in the reserve, so later capacity allocations leave the space for it', async () => {
    const base = skillCatalogReserveBytes([entry]) + loadSkillToolBytes();
    const admitted = await run(() => true);
    expect(admitted?.reserveBytes).toBe(base + serializedResultBytes(voice.text));
    expect(admitted?.frozen.voiceProfile).toEqual(voice.frozen);
    expect(admitted?.text).not.toContain('样例'); // the executor appends the voice itself
  });
  it('drops the voice before the catalog when it does not fit', async () => {
    const base = skillCatalogReserveBytes([entry]) + loadSkillToolBytes();
    const admitted = await run(extra => extra <= base);
    expect(admitted?.reserveBytes).toBe(base);
    expect(admitted?.frozen.voiceProfile).toBeUndefined();
    expect(await run(() => false)).toBeUndefined();
  });
  it('a catalog without the voice keeps the original reserve', async () => {
    mocks.voice = undefined;
    expect((await run(() => true))?.reserveBytes).toBe(skillCatalogReserveBytes([entry]) + loadSkillToolBytes());
  });
});
