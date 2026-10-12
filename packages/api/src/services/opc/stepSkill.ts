/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPositioningWorkflow } from './positioningWorkflow';
import { workbenchService } from '../artifacts/workbench';
import { DatabaseReadError } from '../../lib/databaseReadError';

/*
 * AGENT-CORE R8b: a Skill whose every step declares information fields runs through the mentor flow
 * (cards, per-turn capture, step confirmation). With profileKey fields it is the positioning flow;
 * without, it is a "step Skill" (database work_kind 'step_skill', migration 0229) that never becomes a positioning.
 */
export function isStepFlow(workflow: unknown): boolean {
  const steps = (workflow as { steps?: unknown } | null)?.steps;
  return Array.isArray(steps) && steps.length > 0 && steps.every(step => {
    const fields = (step as { information?: unknown } | null)?.information;
    return Array.isArray(fields) && fields.length > 0;
  });
}

export function isStepSkillWorkflow(workflow: unknown): boolean {
  return isStepFlow(workflow) && !isPositioningWorkflow(workflow);
}

/** Modules whose enabled registration is a step flow: they start only from their own entry, never as a flat Skill. */
export async function stepFlowModuleIds(admin: SupabaseClient): Promise<Set<string>> {
  const raw = await admin.rpc('opc_step_flow_modules');
  if (raw.error || !Array.isArray(raw.data)) throw new Error('RUNTIME_SKILLS_UNAVAILABLE');
  return new Set((raw.data as unknown[]).filter((id): id is string => typeof id === 'string'));
}

/** Step Skills the user can start in the mentor flow: the positioning catalog's twin, for workflows without profileKey. */
export async function stepSkillCatalog(user: SupabaseClient, admin: SupabaseClient) {
  const catalog = await workbenchService(user, admin).catalog();
  const actorId = (await user.auth.getUser()).data.user!.id;
  const raw = await admin.rpc('artifact_query', { p_actor_id: actorId, p_action: 'catalog' });
  if (raw.error) throw new DatabaseReadError('OPC_UNAVAILABLE', raw.error.code);
  return catalog.filter(c =>
    (raw.data as Array<{ id?: unknown; workflow?: unknown }>).some(r => r.id === c.id && isStepSkillWorkflow(r.workflow)));
}
