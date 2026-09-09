/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, it, expect } from 'vitest';
import { readSkillFiles } from './module-skill-editor';
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
});
