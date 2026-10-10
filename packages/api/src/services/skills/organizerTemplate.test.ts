/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach, expect, it} from 'vitest';
import {clearSkillResourceCache, packageHash, sha256, type PackageDescriptor, type SkillSource} from './loader';
import {loadOrganizerTemplate, validateOrganizerTemplate} from './organizerTemplate';
import {parseWorkflowManifest} from './workflowManifest';

function fixture(template: string | null = 'Group audience separately from offer.', declaration = 'assets/organize.md') {
  const files: Record<string, string> = {'SKILL.md': 'private method',
    'workflow.yaml': `kind: document\nsteps:\n - title: First\n   resources: [SKILL.md]\n${template === null ? '' : `organizerTemplate: ${declaration}\n`}`,
    ...(template === null ? {} : {'assets/organize.md': template})};
  const descriptor: PackageDescriptor = {packageId: 'skill', revisionId: 'v11', directoryName: 'sample', packageHash: '',
    tasks: {}, requiredCapabilities: [], files: Object.entries(files).map(([path, content]) => ({path,
      bytes: Buffer.byteLength(content), sha256: sha256(content), mediaType: path.endsWith('.md') ? 'text/markdown' : 'text/yaml', requires: []}))};
  descriptor.packageHash = packageHash(descriptor);
  const reads: string[] = [];
  const source: SkillSource = {list: async () => [descriptor], state: async () => 'enabled',
    read: async ({path}) => {reads.push(path); return Buffer.from(files[path]!);}};
  return {source, descriptor, files, reads};
}
beforeEach(clearSkillResourceCache);
it('reads only the declared template and manifest, not the private method', async () => {
  const f = fixture();
  expect(await loadOrganizerTemplate(f.source, 'v11')).toBe(f.files['assets/organize.md']);
  expect(f.reads).toEqual(['workflow.yaml', 'assets/organize.md']);
});
it('keeps undeclared legacy packages on the general host template', async () => {
  expect(await loadOrganizerTemplate(fixture(null).source, 'v11')).toBeUndefined();
  const f = fixture(null); f.descriptor.files = f.descriptor.files.filter(item => item.path !== 'workflow.yaml');
  f.descriptor.packageHash = packageHash(f.descriptor);
  expect(await loadOrganizerTemplate(f.source, 'v11')).toBeUndefined();
});
it('never substitutes another published revision', async () => {
  await expect(loadOrganizerTemplate(fixture().source, 'v12')).rejects.toThrow('RUNTIME_REVISION_DENIED');
});
it.each(['../outside.md', '/absolute.md', 'https://example.com/template.md', 'assets/missing.md'])('refuses %s', async path => {
  await expect(loadOrganizerTemplate(fixture('template', path).source, 'v11')).rejects.toThrow();
});
it('checks integrity and revocation, including cached resources', async () => {
  const f = fixture(); f.files['assets/organize.md'] = 'tampered';
  await expect(loadOrganizerTemplate(f.source, 'v11')).rejects.toThrow('INTEGRITY_MISMATCH');
  const g = fixture(); await loadOrganizerTemplate(g.source, 'v11');
  g.source.state = async () => 'revoked';
  await expect(loadOrganizerTemplate(g.source, 'v11')).rejects.toThrow('UNAVAILABLE');
});
it.each([Buffer.from(''), Buffer.from(' '), Buffer.alloc(3001, 97), Buffer.from([0xff]), Buffer.from('null\0byte')])(
  'refuses empty, oversized or invalid UTF-8 templates', bytes => {
    expect(() => validateOrganizerTemplate('assets/organize.md', bytes)).toThrow('SKILL_ORGANIZER_TEMPLATE_INVALID');
  });
it('retains strict manifest parsing and does not accept empty or non-text paths', () => {
  expect(() => parseWorkflowManifest('kind: document\norganizerTemplate: 7\nsteps: []')).toThrow();
  expect(() => validateOrganizerTemplate('template.yaml', Buffer.from('text'))).toThrow();
});
