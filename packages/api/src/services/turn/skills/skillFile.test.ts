/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach, expect, it, vi} from 'vitest';
import {clearSkillResourceCache, packageHash, sha256, type SkillSource} from '../../skills/loader';
import {freezeSkillFileBinding, skillFileContinuationBytes} from './skillFile';

function fixture(content = 'Reference text') {
  const base = {
    packageId: '00000000-0000-4000-8000-000000000001',
    revisionId: '00000000-0000-4000-8000-000000000002', directoryName: 'fixture',
    files: [
      {path: 'SKILL.md', bytes: 0, sha256: sha256(''), mediaType: 'text/markdown' as const, requires: []},
      {path: 'references/guide.md', bytes: Buffer.byteLength(content), sha256: sha256(content),
        mediaType: 'text/markdown' as const, requires: []},
    ], tasks: {}, requiredCapabilities: [],
  };
  const descriptor = {...base, packageHash: packageHash(base)};
  const source: SkillSource = {
    list: vi.fn(async () => [descriptor]), state: vi.fn(async () => 'enabled' as const),
    read: vi.fn(async () => Buffer.from(content)),
  };
  return {source, binding: freezeSkillFileBinding(descriptor), descriptor};
}
beforeEach(clearSkillResourceCache);

it('measures cold and cached files with bounded current permission checks, including revocation at the end',async()=>{
 const {source,descriptor}=fixture('Sized reference');
 vi.mocked(source.read).mockImplementation(async identity=>Buffer.from(identity.path==='SKILL.md'?'':'Sized reference'));
 const first=await skillFileContinuationBytes(source,descriptor);
 expect(source.state).toHaveBeenCalledTimes(2);expect(source.read).toHaveBeenCalledTimes(2);
 expect(await skillFileContinuationBytes(source,descriptor)).toBe(first);
 expect(source.state).toHaveBeenCalledTimes(4);expect(source.read).toHaveBeenCalledTimes(2);
 vi.mocked(source.state).mockResolvedValueOnce('enabled').mockResolvedValueOnce('revoked');
 await expect(skillFileContinuationBytes(source,descriptor)).rejects.toThrow('RUNTIME_SKILL_FILE_DENIED');
});
