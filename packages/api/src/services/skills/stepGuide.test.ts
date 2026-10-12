/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach, expect, it} from 'vitest';
import {clearSkillResourceCache, packageHash, sha256, type PackageDescriptor, type SkillSource} from './loader';
import {activateFreeChatSkill, loadStepWork, STEP_GUIDE_MAX_CHARS, stepGuideText} from './stepGuide';
import {parseWorkflowManifest} from './workflowManifest';

const script = `kind: document
steps:
 - title: 找开头
   resources: [SKILL.md, references/hook.md]
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
function fixture(manifest: string | null, hook = 'HOOK_METHOD') {
  const files: Record<string, string> = {'SKILL.md': '---\nname: sample\ndescription: Sample\n---\nprivate method',
    'references/hook.md': hook, ...(manifest === null ? {} : {'workflow.yaml': manifest})};
  const descriptor: PackageDescriptor = {packageId: 'skill', revisionId: 'v1', directoryName: 'sample', packageHash: '',
    tasks: {}, requiredCapabilities: [], files: Object.entries(files).map(([path, content]) => ({path,
      bytes: Buffer.byteLength(content), sha256: sha256(content), mediaType: path.endsWith('.md') ? 'text/markdown' : 'text/yaml', requires: []}))};
  descriptor.packageHash = packageHash(descriptor);
  const reads: string[] = [];
  const source: SkillSource = {list: async () => [descriptor], state: async () => 'enabled',
    read: async ({path}) => {reads.push(path); return Buffer.from(files[path]!);}};
  return {source, reads, descriptor};
}
beforeEach(clearSkillResourceCache);

it('turns a non-positioning Skill\'s steps into an ordered guide and lists the files they declare', async () => {
  const f = fixture(script);
  const work = await loadStepWork(f.source, f.descriptor);
  expect(work!.guide).toContain('1. 找开头\n   - 开头一句：三秒内抓住注意力\n2. 写正文');
  expect(work!.guide).toContain('need no confirmation cards');
  expect(work!.resources).toEqual(['references/hook.md']);
  expect(f.reads).toEqual(['workflow.yaml']);
});
it('free chat loads SKILL.md, the steps\' files and the guide', async () => {
  const f = fixture(script);
  const {instructions} = await activateFreeChatSkill(f.source, f.descriptor, {maxContextBytes: 100000});
  expect(instructions).toContain('private method');
  expect(instructions).toContain('HOOK_METHOD');
  expect(instructions).toContain('Work guide declared by this Skill');
});
it('when the steps\' files do not fit, keeps the Skill usable with SKILL.md and the guide', async () => {
  const f = fixture(script, 'x'.repeat(5000));
  const {instructions} = await activateFreeChatSkill(f.source, f.descriptor, {maxContextBytes: 3000});
  expect(instructions).not.toContain('xxxxx');
  expect(instructions).toContain('private method');
  expect(instructions).toContain('1. 找开头');
});
it('gives positioning no guide and no extra files: it stays the one guided flow', async () => {
  const f = fixture(positioning);
  expect(await loadStepWork(f.source, f.descriptor)).toBeUndefined();
  expect((await activateFreeChatSkill(f.source, f.descriptor, {maxContextBytes: 100000})).instructions).not.toContain('HOOK_METHOD');
});
it('uses the same positioning rule as the positioning entry: a step without fields makes it a guided Skill', () => {
  const mixed = parseWorkflowManifest(positioning + ' - title: 资料\n   resources: [SKILL.md]\n');
  expect(stepGuideText(mixed)).toContain('1. 用户是谁');
});
it('adds nothing for a package without workflow.yaml', async () => {
  const f = fixture(null);
  expect(await loadStepWork(f.source, f.descriptor)).toBeUndefined();
  expect(f.reads).toEqual([]);
});
it('stays within its size cap and never drops a step', () => {
  const steps = Array.from({length: 32}, (_, i) => ({title: '步'.repeat(150) + i, resources: ['SKILL.md'],
    information: Array.from({length: 24}, (_, j) => ({id: 'f' + j, title: '字段'.repeat(70), required: false, description: '说明'.repeat(190)}))}));
  const text = stepGuideText(parseWorkflowManifest(JSON.stringify({kind: 'document', steps})))!;
  expect(text.length).toBeLessThanOrEqual(STEP_GUIDE_MAX_CHARS);
  for (let i = 0; i < 32; i++) expect(text).toContain(`${i + 1}. ${'步'.repeat(150)}${i}`);
  const short = stepGuideText(parseWorkflowManifest(JSON.stringify({kind: 'document', steps: steps.slice(0, 3).map(step =>
    ({...step, information: step.information.slice(0, 2)}))})))!;
  expect(short).toContain('：' + '说明'.repeat(190));
});
it('leaves room for the rest of the request: files over half the budget fall back to SKILL.md and the guide', async () => {
  const f = fixture(script, 'x'.repeat(1800));
  const {instructions} = await activateFreeChatSkill(f.source, f.descriptor, {maxContextBytes: 3000});
  expect(instructions).not.toContain('xxxxx');
  expect(instructions).toContain('1. 找开头');
});
