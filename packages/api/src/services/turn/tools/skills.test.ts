/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
const catalog = vi.hoisted(() => ({ entryInstructions: vi.fn() }));
vi.mock('../skills/skillCatalog', async importOriginal => ({ ...(await importOriginal<object>()), entryInstructions: catalog.entryInstructions }));
import { prepareSkills } from './skills';
import type { SkillCatalogEntry } from '../skills/skillCatalog';
import type { SkillSource } from '../../skills/loader';

const entry = (n: number): SkillCatalogEntry => ({ name: `skill-${n}`, description: 'd', moduleId: `00000000-0000-4000-8000-0000000000${10 + n}`,
  skillId: `00000000-0000-4000-8000-0000000001${10 + n}`, packageId: 'p', revisionId: `00000000-0000-4000-8000-0000000002${10 + n}`,
  packageHash: 'a'.repeat(64), resultBytes: 10 });
const source = {} as SkillSource;

describe('prepareSkills', () => {
  it('reads at most three entries at once, keeps catalog order, and leaves out an entry that cannot load', async () => {
    let running = 0, peak = 0;
    catalog.entryInstructions.mockImplementation(async (_source, item: SkillCatalogEntry) => {
      running++; peak = Math.max(peak, running);
      // Later entries answer first, so a map filled in finishing order would come out reversed.
      await new Promise(resolve => setTimeout(resolve, 12 - Number(item.name.slice(6))));
      running--;
      if (item.name === 'skill-4') throw new Error('RUNTIME_SKILL_LOAD_DENIED');
      return `text of ${item.name}`;
    });
    const entries = [1, 2, 3, 4, 5, 6, 7, 8].map(entry);
    const prepared = await prepareSkills(entries, () => source, 1000);
    expect(peak).toBe(3);
    expect([...prepared.keys()]).toEqual(['skill-1', 'skill-2', 'skill-3', 'skill-5', 'skill-6', 'skill-7', 'skill-8']);
    expect(JSON.parse(prepared.get('skill-2')!)).toMatchObject({ name: 'skill-2', instructions: 'text of skill-2' });
  });

  it('an entry whose source cannot even be built is left out like one that cannot load', async () => {
    catalog.entryInstructions.mockResolvedValue('text');
    const prepared = await prepareSkills([entry(1), entry(2)], item => { if (item.name === 'skill-1') throw new Error('UNAVAILABLE'); return source; }, 1000);
    expect([...prepared.keys()]).toEqual(['skill-2']);
  });

  it('nothing to read is an empty map', async () => {
    expect((await prepareSkills([], () => source, 1000)).size).toBe(0);
  });
});
