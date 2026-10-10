/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach, expect, it, vi} from 'vitest';
import {clearSkillResourceCache, packageHash, sha256, type SkillSource} from '../skills/loader';
import {freezeSkillFileBinding, readFrozenSkillFile, skillFileContinuationBytes, SKILL_FILE_MAX_BYTES} from './skillFile';

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
const args = {path: 'references/guide.md'};
beforeEach(clearSkillResourceCache);
it('reads exact verified published bytes and replays without reading content again', async () => {
  const {source, binding} = fixture();
  const saved = await readFrozenSkillFile({source, binding, arguments: args, saved: null});
  expect(saved.content).toBe('Reference text');
  vi.mocked(source.read).mockRejectedValue(new Error('must not read on replay'));
  expect(await readFrozenSkillFile({source, binding, arguments: args, saved})).toEqual(saved);
  expect(source.read).toHaveBeenCalledTimes(1);
});
it.each(['../secret.md', '/secret.md', 'references/%2e%2e/x.md', 'references\\guide.md', 'unknown.md'])(
  'refuses undeclared or unsafe path %s before content read', async path => {
    const {source, binding} = fixture();
    await expect(readFrozenSkillFile({source, binding, arguments: {path}, saved: null})).rejects.toThrow();
    expect(source.read).not.toHaveBeenCalled();
  },
);
it('rejects extra arguments that try to select another package', async () => {
  const {source, binding} = fixture();
  await expect(readFrozenSkillFile({source, binding, arguments: {...args, revisionId: binding.revisionId}, saved: null}))
    .rejects.toThrow();
  expect(source.read).not.toHaveBeenCalled();
});
it('rejects another bound version', async () => {
  const {source, binding} = fixture();
  await expect(readFrozenSkillFile({source, binding: {...binding,
    revisionId: '00000000-0000-4000-8000-000000000003'}, arguments: args, saved: null})).rejects.toThrow();
  expect(source.read).not.toHaveBeenCalled();
});
it('checks revoked access even when replaying a saved result', async () => {
  const {source, binding} = fixture();
  const saved = await readFrozenSkillFile({source, binding, arguments: args, saved: null});
  vi.mocked(source.state).mockResolvedValue('revoked');
  await expect(readFrozenSkillFile({source, binding, arguments: args, saved})).rejects.toThrow('RUNTIME_SKILL_FILE_DENIED');
});
it('rejects corrupt saved bytes', async () => {
  const {source, binding} = fixture();
  const saved = await readFrozenSkillFile({source, binding, arguments: args, saved: null});
  await expect(readFrozenSkillFile({source, binding, arguments: args, saved: {...saved, content: 'tampered'}}))
    .rejects.toThrow('RUNTIME_SKILL_FILE_CONFLICT');
});
it('rejects oversized resources before source read', async () => {
  const {source, binding} = fixture('中'.repeat(SKILL_FILE_MAX_BYTES));
  await expect(readFrozenSkillFile({source, binding, arguments: args, saved: null}))
    .rejects.toThrow('RUNTIME_SKILL_FILE_TOO_LARGE');
  expect(source.read).not.toHaveBeenCalled();
});
it('rejects corrupted source bytes and publication revoked during read', async () => {
  const first = fixture();
  vi.mocked(first.source.read).mockResolvedValue(Buffer.from('wrong'));
  await expect(readFrozenSkillFile({...first, arguments: args, saved: null})).rejects.toThrow('INTEGRITY_MISMATCH');
  const second = fixture();
  vi.mocked(second.source.read).mockImplementation(async () => {
    vi.mocked(second.source.state).mockResolvedValue('revoked');
    return Buffer.from('Reference text');
  });
  await expect(readFrozenSkillFile({...second, arguments: args, saved: null})).rejects.toThrow('UNAVAILABLE');
});

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
