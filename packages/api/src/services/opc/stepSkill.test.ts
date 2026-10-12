/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isStepFlow, isStepSkillWorkflow, stepFlowModuleIds } from './stepSkill';
import { isPositioningWorkflow } from './positioningWorkflow';

const step = (information: unknown[]) => ({ id: 's', information });
const script = { steps: [step([{ id: 'hook', title: '开头', required: true }]), step([{ id: 'body', title: '正文', required: true }])] };
const positioning = { steps: [step([{ id: 'who', title: '用户', required: true, profileKey: 'audience' }])] };

it('tells a step Skill from positioning and from a Skill without steps', () => {
  expect(isStepSkillWorkflow(script)).toBe(true);
  expect(isPositioningWorkflow(script)).toBe(false);
  expect(isStepSkillWorkflow(positioning)).toBe(false);
  expect(isStepFlow(positioning)).toBe(true);
  for (const flat of [null, {}, { steps: [] }, { steps: [{ id: 's' }] }, { steps: [step([]), step([{ id: 'x' }])] }]) {
    expect(isStepFlow(flat)).toBe(false);
    expect(isStepSkillWorkflow(flat)).toBe(false);
  }
});

it('reads the step-flow modules from the database and fails closed', async () => {
  const rpc = vi.fn(async () => ({ data: ['m-script', 'm-positioning'], error: null }));
  expect([...await stepFlowModuleIds({ rpc } as unknown as SupabaseClient)].sort()).toEqual(['m-positioning', 'm-script']);
  expect(rpc).toHaveBeenCalledWith('opc_step_flow_modules');
  const failing = { rpc: async () => ({ data: null, error: { message: 'x' } }) } as unknown as SupabaseClient;
  await expect(stepFlowModuleIds(failing)).rejects.toThrow('RUNTIME_SKILLS_UNAVAILABLE');
});
