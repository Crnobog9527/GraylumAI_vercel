/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { prepareModuleSkill, saveModuleSkill, type ModuleSkillInput } from '../skills/modulePublication';
import { makePackage } from './fixtures/artifacts';
export function moduleInput(): ModuleSkillInput {
  const pack = makePackage();
  return { moduleId: randomUUID(), skillId: pack.id, revisionId: pack.revisionId, requestId: pack.requestId,
    expectedUpdatedAt: null, expectedVersion: 0, directoryName: 'synthetic-method', kind: 'document',
    files: pack.files, steps: [{ title: '需求', resources: ['references/step-0.md'] }, { title: '成果', resources: ['SKILL.md'] }],
    resourcePlanReviewed: true, module: { title: 'Synthetic private method', description: null, full_description: null,
      model_id: randomUUID(), platform: 'all', category: 'analysis', icon: 'Wand2', image_url: null,
      badge_type: null, badge_text: null, credits_display: null, sort_order: 0, active: true, is_featured: false,
      features: null, examples: null, preparation_questions: null },
  };
}
describe('administrator module publication', () => {
  it('preserves exact files and creates sequential dependencies and report sections', () => {
    const input = moduleInput(), result = prepareModuleSkill(input);
    expect(result.files).toEqual(input.files);
    expect(result.workflow.steps[1].dependsOn).toEqual(['step-1']);
    expect(result.workflow.report.sections).toEqual([{ title: '需求', stepId: 'step-1' }, { title: '成果', stepId: 'step-2' }]);
    expect(result.descriptor.tasks).toEqual({});
  });
  it('accepts YAML as read-only bytes, including tags without interpreting them', () => {
    const input = moduleInput(), base64 = Buffer.from('state: !!custom tagged\n').toString('base64');
    input.files.push({ path: 'assets/state.yaml', base64 });
    input.steps[0].resources.push('assets/state.yaml');
    const result = prepareModuleSkill(input);
    expect(result.files.at(-1)?.base64).toBe(base64);
    expect(result.descriptor.files.at(-1)?.mediaType).toBe('text/yaml');
  });
  it.each(['scripts/run.md', '../secret.md', 'asset.js', 'image.png'])('rejects unsupported or escaping path %s', path => {
    const input = moduleInput(); input.files.push({ path, base64: 'YQ==' });
    expect(() => prepareModuleSkill(input)).toThrow();
  });
  it('rejects missing resources, invalid entry and unreviewed plans before any write', async () => {
    for (const change of [
      (x: ModuleSkillInput) => { x.steps[0].resources = ['missing.md']; },
      (x: ModuleSkillInput) => { x.files[0].base64 = Buffer.from('no metadata').toString('base64'); },
      (x: ModuleSkillInput) => { x.resourcePlanReviewed = false as true; },
    ]) { const db = { rpc: vi.fn() }, input = moduleInput(); change(input);
      await expect(saveModuleSkill(db as any, randomUUID(), input)).rejects.toThrow(); expect(db.rpc).not.toHaveBeenCalled(); }
  });
  it('writes package, binding, workflow and visibility through one atomic RPC with server actor', async () => {
    const input = moduleInput(), actor = randomUUID(), db = { from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:{id:input.module.model_id,name:'Qwen',model_id:'qwen/qwen3.8-27b',provider:'openai',is_active:'true',max_tokens:4096,input_limit:800000,api_key:'LOCAL_ONLY',api_endpoint:''},error:null})}), rpc: vi.fn().mockResolvedValue({ data: { moduleId: input.moduleId }, error: null }) };
    await saveModuleSkill(db as any, actor, input);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('admin_publish_skill_module', expect.objectContaining({
      p_actor_id: actor, p_metadata: input.module, p_expected_updated_at: null, p_request_id: input.requestId,
    }));
  });
  it('carries an explicit per-field elicitation declaration into the published workflow', () => {
    const input = moduleInput();
    input.steps[0].information = [
      { id: 'owned_fact', title: '用户自有事实', required: true, elicitation: 'user_fact' },
      { id: 'agent_deliverable', title: '导师成果建议', required: true, elicitation: 'agent_proposal' },
    ];
    const published = prepareModuleSkill(input).workflow.steps[0].information;
    // Both values survive identically, and nothing rewrites them.
    expect(published).toEqual([
      { id: 'owned_fact', title: '用户自有事实', required: true, elicitation: 'user_fact' },
      { id: 'agent_deliverable', title: '导师成果建议', required: true, elicitation: 'agent_proposal' },
    ]);
  });
  it('keeps an older revision without the property valid and publishable', async () => {
    const input = moduleInput();
    input.steps[0].information = [{ id: 'legacy_fact', title: '旧版字段', required: true, profileKey: 'legacy_fact' }];
    const published = prepareModuleSkill(input).workflow.steps[0].information;
    expect(published).toEqual([{ id: 'legacy_fact', title: '旧版字段', required: true, profileKey: 'legacy_fact' }]);
    expect(published?.[0]).not.toHaveProperty('elicitation');
    const db = { from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:{id:input.module.model_id,name:'Qwen',model_id:'qwen/qwen3.8-27b',provider:'openai',is_active:'true',max_tokens:4096,input_limit:800000,api_key:'LOCAL_ONLY',api_endpoint:''},error:null})}), rpc: vi.fn().mockResolvedValue({ data: { moduleId: input.moduleId }, error: null }) };
    await expect(saveModuleSkill(db as any, randomUUID(), input)).resolves.toBeTruthy();
    expect(db.rpc).toHaveBeenCalledOnce();
  });
  it('rejects an invalid elicitation value and unknown field properties before any write', async () => {
    for (const change of [
      (x: ModuleSkillInput) => { x.steps[0].information = [{ id: 'f', title: '字段', required: true, elicitation: 'proposal' as never }]; },
      (x: ModuleSkillInput) => { x.steps[0].information = [{ id: 'f', title: '字段', required: true, elicitation: 'AGENT_PROPOSAL' as never }]; },
      (x: ModuleSkillInput) => { x.steps[0].information = [{ id: 'f', title: '字段', required: true, inferred: true } as never]; },
    ]) {
      const db = { rpc: vi.fn() }, input = moduleInput(); change(input);
      expect(() => prepareModuleSkill(input)).toThrow();
      await expect(saveModuleSkill(db as any, randomUUID(), input)).rejects.toThrow();
      expect(db.rpc).not.toHaveBeenCalled();
    }
  });
});
