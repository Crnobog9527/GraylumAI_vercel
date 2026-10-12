/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach, expect, it} from 'vitest';
import {clearSkillResourceCache, packageHash, sha256, type PackageDescriptor, type SkillSource} from './loader';
import {loadStepGuide, STEP_GUIDE_MAX_CHARS, stepGuideText} from './stepGuide';
import {parseWorkflowManifest} from './workflowManifest';

const script = `kind: document
steps:
 - title: 找开头
   resources: [SKILL.md]
   information:
    - {id: hook, title: 开头一句, required: true, description: 三秒内抓住注意力}
 - title: 写正文
   resources: [SKILL.md]
`;
const positioning = `kind: document
steps:
 - title: 用户是谁
   resources: [SKILL.md]
   information:
    - {id: who, title: 目标用户, required: true, profileKey: audience}
`;
function fixture(manifest: string | null) {
  const files: Record<string, string> = {'SKILL.md': 'private method', ...(manifest === null ? {} : {'workflow.yaml': manifest})};
  const descriptor: PackageDescriptor = {packageId: 'skill', revisionId: 'v1', directoryName: 'sample', packageHash: '',
    tasks: {}, requiredCapabilities: [], files: Object.entries(files).map(([path, content]) => ({path,
      bytes: Buffer.byteLength(content), sha256: sha256(content), mediaType: path.endsWith('.md') ? 'text/markdown' : 'text/yaml', requires: []}))};
  descriptor.packageHash = packageHash(descriptor);
  const reads: string[] = [];
  const source: SkillSource = {list: async () => [descriptor], state: async () => 'enabled',
    read: async ({path}) => {reads.push(path); return Buffer.from(files[path]!);}};
  return {source, reads};
}
beforeEach(clearSkillResourceCache);

it('turns a non-positioning Skill\'s steps into an ordered guide with field titles and descriptions', async () => {
  const f = fixture(script);
  const guide = await loadStepGuide(f.source, 'v1');
  expect(guide).toContain('1. 找开头\n   - 开头一句：三秒内抓住注意力\n2. 写正文');
  expect(guide).toContain('need no confirmation cards');
  expect(f.reads).toEqual(['workflow.yaml']);
});
it('gives positioning no guide: it stays the one guided flow', async () => {
  expect(await loadStepGuide(fixture(positioning).source, 'v1')).toBeUndefined();
});
it('adds nothing for a package without workflow.yaml and never reads another revision', async () => {
  const f = fixture(null);
  expect(await loadStepGuide(f.source, 'v1')).toBeUndefined();
  expect(f.reads).toEqual([]);
  await expect(loadStepGuide(fixture(script).source, 'v2')).rejects.toThrow('RUNTIME_REVISION_DENIED');
});
it('stays within its size cap', () => {
  const steps = Array.from({length: 32}, (_, i) => ({title: '步骤'.repeat(70) + i, resources: ['SKILL.md'],
    information: Array.from({length: 24}, (_, j) => ({id: 'f' + j, title: '字段'.repeat(70), required: false, description: '说明'.repeat(190)}))}));
  const text = stepGuideText(parseWorkflowManifest(JSON.stringify({kind: 'document', steps})));
  expect(text!.length).toBeLessThanOrEqual(STEP_GUIDE_MAX_CHARS);
});
