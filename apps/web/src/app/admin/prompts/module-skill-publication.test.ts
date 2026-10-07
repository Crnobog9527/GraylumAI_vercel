/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { prepareModuleSkill, type ModuleSkillInput } from '@repo/api/skills/modulePublication';
import { readSkillFiles, skillPublicationFields, type SkillForm } from './module-skill-editor';
function file(path: string, content = 'source') {
  const f = new File([content], path.split('/').at(-1)!);
  Object.defineProperty(f, 'webkitRelativePath', { value: 'demo/' + path });
  return f;
}
const steps = 'kind: social\nplanResources: [references/report.md]\nsteps:\n  - title: 了解你\n    resources: [SKILL.md]\n';
const report = 'reportGeneration:\n  resources: [references/report.md]\n  sections: [定位结论, 行动计划]\n  maxCharacters: 8000\n';
// Mirrors the editor import followed by page.tsx handleSubmit.
async function payload(workflow: string): Promise<ModuleSkillInput> {
  const read = await readSkillFiles([file('SKILL.md', '---\nname: demo\ndescription: Fictional test method\n---\n# Demo\n'), file('references/report.md'), file('workflow.yaml', workflow)]);
  const form: SkillForm = { directoryName: read.directoryName, files: read.files, ...read.workflow!, reviewed: true };
  return { moduleId: randomUUID(), skillId: randomUUID(), revisionId: randomUUID(), requestId: randomUUID(),
    expectedUpdatedAt: null, expectedVersion: 7, directoryName: form.directoryName, ...skillPublicationFields(form),
    resourcePlanReviewed: true, module: { title: '定位', description: null, full_description: null,
      model_id: randomUUID(), platform: 'all', category: 'marketing', icon: 'Wand2', image_url: null,
      badge_type: null, badge_text: null, credits_display: null, sort_order: 0, active: true, is_featured: false,
      features: null, examples: null, preparation_questions: null } };
}
describe('module Skill publication payload', () => {
  it('forwards a declared reportGeneration so the server accepts the package', async () => {
    const input = await payload(steps + report);
    expect(input.reportGeneration).toEqual({ resources: ['references/report.md'], sections: ['定位结论', '行动计划'], maxCharacters: 8000 });
    expect(prepareModuleSkill(input).workflow.reportGeneration).toEqual(input.reportGeneration);
  });
  it('rejects a payload that drops the declared reportGeneration', async () => {
    const input = await payload(steps + report);
    expect(() => prepareModuleSkill({ ...input, reportGeneration: undefined })).toThrow('workflow.yaml');
  });
  it('omits reportGeneration when the package does not declare it', async () => {
    const input = await payload(steps);
    expect('reportGeneration' in input).toBe(false);
    expect(prepareModuleSkill(input).workflow.reportGeneration).toBeUndefined();
  });
});
