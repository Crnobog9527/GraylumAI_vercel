/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {beforeEach, it, expect, vi} from 'vitest';
import {activateSkill, clearSkillResourceCache, identityOf, packageHash, readResourceBatch, sha256,
  type SkillSource} from './loader';
const contents = new Map<string, string>([
  ['SKILL.md', '---\nname: fixture\ndescription: Testing.\n---\nEntry'],
  ...Array.from({length: 8}, (_, i): [string, string] => [`part${i}.md`, `part-${i}`]),
]);
const base = {packageId: 'fixture', revisionId: 'v1', directoryName: 'fixture', tasks: {}, requiredCapabilities: [],
  files: [...contents].map(([path, content]) => ({path, bytes: Buffer.byteLength(content), sha256: sha256(content),
    mediaType: 'text/markdown' as const, requires: []}))};
const descriptor = {...base, packageHash: packageHash(base)};
beforeEach(clearSkillResourceCache);
it('bounds cold reads to four, preserves the context, and checks revocation again on a warm request', async () => {
  let active = 0, peak = 0, revoked = false;
  const source: SkillSource = {list: async () => [descriptor], state: async () => revoked ? 'revoked' : 'enabled',
    read: vi.fn(async identity => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return Buffer.from(contents.get(identity.path)!);
    })};
  const options = {resources: [...contents.keys()].slice(1), maxContextBytes: 20000};
  const loaded = await activateSkill(source, identityOf(descriptor), options);
  expect(peak).toBe(4);
  expect(JSON.parse(loaded.forModel()).resources).toEqual([...contents].map(([path, content]) => ({path, content})));
  expect(source.read).toHaveBeenCalledTimes(9);
  revoked = true;
  await expect(activateSkill(source, identityOf(descriptor), options)).rejects.toMatchObject({code: 'UNAVAILABLE'});
  expect(source.read).toHaveBeenCalledTimes(9);
});
it('does not return assembled content when access is revoked during cold reads', async () => {
  let revoked = false;
  const source: SkillSource = {list: async () => [descriptor], state: async () => revoked ? 'revoked' : 'enabled',
    read: async identity => {revoked = true; return Buffer.from(contents.get(identity.path)!);}};
  await expect(activateSkill(source, identityOf(descriptor), {maxContextBytes: 20000}))
    .rejects.toMatchObject({code: 'UNAVAILABLE'});
});
it('waits for the bounded in-flight batch on failure and does not start the next batch', async () => {
  const calls: number[] = [], completed: number[] = [];
  const failure = Error('denied');
  await expect(readResourceBatch([0, 1, 2, 3, 4, 5], async i => {
    calls.push(i);
    if (i === 0) throw failure;
    await new Promise(resolve => setTimeout(resolve, 1));
    completed.push(i);
    return i;
  })).rejects.toBe(failure);
  expect(calls).toEqual([0, 1, 2, 3]);
  expect(completed).toEqual([1, 2, 3]);
});
