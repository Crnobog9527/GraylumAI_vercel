/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// R8b: a Skill picked by free-chat matching runs with its declared steps as a work guide, same as a chosen Skill.
import {beforeEach, expect, it, vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {clearSkillResourceCache, packageHash, sha256, type PackageDescriptor, type SkillSource} from '../skills/loader';
const source = vi.hoisted(() => ({current: undefined as SkillSource | undefined}));
vi.mock('../skills/databaseSource', () => ({databaseSkillSource: () => source.current, userVisibleModules: vi.fn()}));
const {activateRuntimeCandidate} = await import('./matching');

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function install(workflow: string | null) {
  const files: Record<string, string> = {'SKILL.md': '---\nname: script\ndescription: Short videos\n---\nWrite scripts.',
    ...(workflow === null ? {} : {'workflow.yaml': workflow})};
  const descriptor: PackageDescriptor = {packageId: id(1), revisionId: id(2), directoryName: 'script', packageHash: '',
    tasks: {}, requiredCapabilities: [], files: Object.entries(files).map(([path, content]) => ({path,
      bytes: Buffer.byteLength(content), sha256: sha256(content), mediaType: path.endsWith('.md') ? 'text/markdown' : 'text/yaml', requires: []}))};
  descriptor.packageHash = packageHash(descriptor);
  source.current = {list: async () => [descriptor], state: async () => 'enabled', read: async ({path}) => Buffer.from(files[path]!)};
  return {key: 'candidate-0', name: 'script', description: 'Short videos', moduleId: id(3), skillId: id(4),
    packageId: id(1), revisionId: id(2), packageHash: descriptor.packageHash, modelId: id(5), model: 'fixture/m',
    inputLimit: 100000, outputLimit: 1000, requiresTask: false};
}
beforeEach(clearSkillResourceCache);
const db = {} as SupabaseClient;

it('appends the declared steps of a matched non-positioning Skill', async () => {
  const text = await activateRuntimeCandidate(db, db, install('kind: document\nsteps:\n - title: 找开头\n   resources: [SKILL.md]\n'));
  expect(text).toContain('Write scripts.');
  expect(text).toContain('Work guide declared by this Skill');
  expect(text).toContain('1. 找开头');
});
it('leaves a Skill without workflow.yaml unchanged', async () => {
  expect(await activateRuntimeCandidate(db, db, install(null))).not.toContain('Work guide');
});
it('a matched Skill gets the guide but not the steps\' files, so sizing equals execution and reads no step files', async () => {
  const candidate = install('kind: document\nsteps:\n - title: 找开头\n   resources: [SKILL.md, references/hook.md]\n');
  const reads: string[] = [];
  const inner = source.current!;
  source.current = {...inner, read: async (identity, maxBytes) => { reads.push(identity.path); return inner.read(identity, maxBytes); }};
  const first = await activateRuntimeCandidate(db, db, candidate);
  expect(first).toContain('1. 找开头');
  expect(reads).not.toContain('references/hook.md');
  expect(await activateRuntimeCandidate(db, db, candidate)).toBe(first);
});
