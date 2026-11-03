/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {packageHash, sha256} from '../../skills/loader';
import {loadSkillToolBytes} from './loadSkillTool';
import {MAX_SKILL_LOADS_PER_TURN, skillCatalogInstructions, skillCatalogReserveBytes, type SkillCatalogEntry} from './skillCatalog';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const SKILL = '---\nname: script-writer\ndescription: 用户要写或改短视频口播稿时使用。\n---\n先问清主题，再写 60 秒口播稿。\n';
function descriptor() {
  const p = {packageId: id(11), revisionId: id(21), directoryName: 'script-writer', packageHash: '', tasks: {},
    requiredCapabilities: [] as string[], files: [{path: 'SKILL.md', bytes: Buffer.byteLength(SKILL), sha256: sha256(SKILL),
      mediaType: 'text/markdown' as const, requires: [] as string[]}]};
  p.packageHash = packageHash(p);
  return p;
}
const entry = (over: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry => ({name: 'script-writer', description: '用户要写口播稿时使用。',
  moduleId: id(1), skillId: id(11), packageId: id(11), revisionId: id(21), packageHash: descriptor().packageHash, resultBytes: 500,
  ...over});

describe('load_skill', () => {
  it('declares a small fixed tool definition', () => {
    expect(loadSkillToolBytes()).toBeGreaterThan(100);
    expect(loadSkillToolBytes()).toBeLessThan(1000);
  });
});

describe('skill catalog text and reserve', () => {
  it('lists only names and descriptions, says the limit, and is empty without Skills', () => {
    expect(skillCatalogInstructions([])).toBe('');
    const text = skillCatalogInstructions([entry()]);
    expect(text).toContain('load_skill');
    expect(text).toContain(`at most ${MAX_SKILL_LOADS_PER_TURN} per reply`);
    expect(text).toContain('{"name":"script-writer","description":"用户要写口播稿时使用。"}');
    expect(text).not.toContain(id(1));
  });
  it('reserves the largest loads one reply may make (Owner: at most 2)', () => {
    expect(MAX_SKILL_LOADS_PER_TURN).toBe(2);
    expect(skillCatalogReserveBytes([entry({resultBytes: 100}), entry({resultBytes: 900}), entry({resultBytes: 500})])).toBe(1400);
    expect(skillCatalogReserveBytes([])).toBe(0);
  });
});
