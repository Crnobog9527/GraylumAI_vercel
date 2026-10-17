/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, it, expect } from 'vitest';
import { guidanceNote, readSkillFiles } from './module-skill-editor';
function file(path: string, content: string | Uint8Array = 'source') {
  const f = new File([content as BlobPart], path.split('/').at(-1)!);
  Object.defineProperty(f, 'webkitRelativePath', { value: 'demo/' + path });
  return f;
}
describe('administrator folder import', () => {
  it('preserves nested Markdown and YAML bytes and infers the directory only', async () => {
    const result = await readSkillFiles([file('SKILL.md','原版正文'), file('assets/state.yaml','state: null\n')]);
    expect(result.directoryName).toBe('demo');
    expect(result.files.map(f => f.path)).toEqual(['SKILL.md','assets/state.yaml']);
    expect(Buffer.from(result.files[0].base64,'base64').toString()).toBe('原版正文');
  });
  it('rejects executable files, missing entry and invalid encoding without partial import', async () => {
    await expect(readSkillFiles([file('SKILL.md'),file('scripts/run.js')])).rejects.toThrow('不受支持');
    await expect(readSkillFiles([file('references/only.md')])).rejects.toThrow('SKILL.md');
    await expect(readSkillFiles([file('SKILL.md',new Uint8Array([0xc3,0x28]))])).rejects.toThrow('UTF-8');
  });
  it('loads changed steps and questions from the uploaded workflow declaration', async () => {
    const result = await readSkillFiles([file('SKILL.md'),file('workflow.yaml',
      'kind: social\nsteps:\n  - title: 需求确认\n    resources: [SKILL.md]\n    information:\n      - id: product\n        title: 产品与服务\n        required: true\n  - title: 效果验证\n    resources: [SKILL.md]\n    information:\n      - id: measure\n        title: 如何验证效果\n        required: true\n')]);
    expect(result.workflow?.steps.map(step=>step.title)).toEqual(['需求确认','效果验证']);
    expect(result.workflow?.steps[1].information?.[0].title).toBe('如何验证效果');
  });
  it('rejects ambiguous workflow declarations before replacing the current editor state', async () => {
    await expect(readSkillFiles([file('SKILL.md'),file('workflow.yaml',
      'kind: social\nsteps: *missing\n')])).rejects.toThrow('workflow.yaml');
  });
});
describe('guided step flow label (positioning only)', () => {
  const step = (information?: {id:string;title:string;required:boolean;profileKey?:string}[]) => ({ title: '步骤', resources: ['SKILL.md'], information });
  it('marks a positioning Skill as the guided flow', () => {
    expect(guidanceNote([step([{id:'a',title:'受众',required:true,profileKey:'audience'}]), step([{id:'b',title:'差异',required:true}])]))
      .toContain('定位 Skill：');
  });
  it('asks the administrator to confirm a Skill that asks questions at every step without a profile key', () => {
    expect(guidanceNote([step([{id:'a',title:'受众',required:true}])])).toMatch(/^请确认.*不是定位 Skill/);
  });
  it('states that any other Skill only gives the AI a work order', () => {
    expect(guidanceNote([step(), step([{id:'a',title:'受众',required:true,profileKey:'audience'}])])).toMatch(/^不是定位 Skill/);
    expect(guidanceNote([step()])).toMatch(/^不是定位 Skill/);
  });
});
