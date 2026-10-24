/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {clearSkillResourceCache, packageHash, sha256} from '../skills/loader';
import {executionLoadSkillTool, LOAD_SKILL_TOOL, loadSkillToolBytes, SKILL_LOAD_REFUSED} from './loadSkillTool';
import {MAX_SKILL_LOADS_PER_TURN, skillCatalogInstructions, skillCatalogReserveBytes, type SkillCatalogEntry} from './skillCatalog';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const SKILL = '---\nname: script-writer\ndescription: 用户要写或改短视频口播稿时使用。\n---\n先问清主题，再写 60 秒口播稿。\n';
const files = {'SKILL.md': SKILL};
function descriptor() {
  const p = {packageId: id(11), revisionId: id(21), directoryName: 'script-writer', packageHash: '', tasks: {},
    requiredCapabilities: [] as string[], files: Object.entries(files).map(([path, text]) => ({path,
      bytes: Buffer.byteLength(text), sha256: sha256(text), mediaType: 'text/markdown' as const, requires: [] as string[]}))};
  p.packageHash = packageHash(p);
  return p;
}
const entry = (over: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry => ({name: 'script-writer', description: '用户要写口播稿时使用。',
  moduleId: id(1), skillId: id(11), packageId: id(11), revisionId: id(21), packageHash: descriptor().packageHash, resultBytes: 500,
  ...over});

function rpc(saved: unknown = null) {
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
beforeEach(() => clearSkillResourceCache());

describe('load_skill', () => {
  it('reads the frozen package, journals the result and returns the Skill instructions', async () => {
    const call = rpc();
    const tool = executionLoadSkillTool({executionId: id(9), catalog: [entry()], maxResultBytes: 20000, maxLoads: 2, rpc: call,
      assertCanStart: () => {}});
    expect(tool.name).toBe(LOAD_SKILL_TOOL);
    const result = JSON.parse(await tool.execute({name: 'script-writer'}, 'call-1'));
    expect(result).toMatchObject({name: 'script-writer', moduleId: id(1), revisionId: id(21)});
    expect(result.instructions).toContain('先问清主题');
    const complete = call.mock.calls.find(([name, args]) => name === 'runtime_tool' && args.p_action === 'complete')!;
    expect(complete[1]).toMatchObject({p_execution_id: id(9), p_call_id: 'call-1', p_name: 'load_skill', p_arguments: {query: 'script-writer'}});
  });

  it('returns the journaled result on replay without reading the package again', async () => {
    const saved = {name: 'script-writer', moduleId: id(1), packageId: id(11), revisionId: id(21), packageHash: descriptor().packageHash,
      instructions: '已保存的说明'};
    const call = rpc(saved);
    const tool = executionLoadSkillTool({executionId: id(9), catalog: [entry()], maxResultBytes: 20000, maxLoads: 2, rpc: call, assertCanStart: () => {}});
    expect(JSON.parse(await tool.execute({name: 'script-writer'}, 'call-1'))).toEqual(saved);
    expect(call.mock.calls.some(([name]) => name === 'read_skill_package')).toBe(false);
  });

  it('tells the model a permanent refusal (name outside the catalog, package changed) without failing the run', async () => {
    const onRefused = vi.fn();
    const call = rpc({name: 'script-writer', moduleId: id(1), packageId: id(11), revisionId: id(22), packageHash: 'a'.repeat(64),
      instructions: 'x'});
    const tool = executionLoadSkillTool({executionId: id(9), catalog: [entry()], maxResultBytes: 20000, maxLoads: 2, rpc: call,
      assertCanStart: () => {}, onRefused});
    expect(await tool.execute({name: '别的技能'}, 'c')).toBe(SKILL_LOAD_REFUSED);
    expect(call).not.toHaveBeenCalled();
    expect(await tool.execute({name: 'script-writer'}, 'c')).toBe(SKILL_LOAD_REFUSED);
    expect(onRefused).toHaveBeenCalledTimes(2);
    expect(tool.invalidResult).toBeUndefined();
  });

  it('a refusal the executor classified (a third load, a name not frozen) is permanent', async () => {
    const call = vi.fn(async () => { throw new Error('RUNTIME_SKILL_LOAD_REFUSED'); }) as never;
    const tool = executionLoadSkillTool({executionId: id(9), catalog: [entry()], maxResultBytes: 20000, maxLoads: 2, rpc: call, assertCanStart: () => {}});
    expect(await tool.execute({name: 'script-writer'}, 'c')).toBe(SKILL_LOAD_REFUSED);
  });

  it('a revoked or disabled package (the package reader refuses) is a permanent refusal, not a retry', async () => {
    const onRefused = vi.fn();
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'read_skill_package') throw new Error('RUNTIME_SKILL_FILE_REFUSED');
      return args.p_action === 'claim' ? {result: null} : {result: args.p_result};
    }) as never;
    const tool = executionLoadSkillTool({executionId: id(9), catalog: [entry()], maxResultBytes: 20000, maxLoads: 2, rpc: call,
      assertCanStart: () => {}, onRefused});
    expect(await tool.execute({name: 'script-writer'}, 'c')).toBe(SKILL_LOAD_REFUSED);
    expect(onRefused).toHaveBeenCalledOnce();
  });

  it('lets an uncertain failure propagate so recovery can replay the journaled result', async () => {
    const onRefused = vi.fn();
    for (const failure of [new Error('fetch failed'), new Error('RUNTIME_TOOL_CLOSED'), new Error('canceling statement due to timeout')]) {
      let first = true;
      const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'read_skill_package') {
          if (args.p_path === null) return descriptor();
          if (args.p_path === '') return true;
          return Buffer.from(files[args.p_path as keyof typeof files]).toString('base64');
        }
        if (args.p_action === 'claim') return {result: null};
        if (first) { first = false; throw failure; }
        return {result: args.p_result};
      }) as never;
      const tool = executionLoadSkillTool({executionId: id(9), catalog: [entry()], maxResultBytes: 20000, maxLoads: 2, rpc: call,
        assertCanStart: () => {}, onRefused});
      await expect(tool.execute({name: 'script-writer'}, 'c')).rejects.toThrow(failure.message);
      clearSkillResourceCache();
    }
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('stops being offered after the load limit (Owner: at most 2 per reply), counting refused calls too', async () => {
    const tool = executionLoadSkillTool({executionId: id(9), catalog: [entry()], maxResultBytes: 20000, maxLoads: 2, rpc: rpc(),
      assertCanStart: () => {}});
    expect(tool.enabled?.()).toBe(true);
    await tool.execute({name: 'script-writer'}, 'c1');
    expect(tool.enabled?.()).toBe(true);
    await tool.execute({name: 'not-listed'}, 'c2');
    expect(tool.enabled?.()).toBe(false);
  });

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
