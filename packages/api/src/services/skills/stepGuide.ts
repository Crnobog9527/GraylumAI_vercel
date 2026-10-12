/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {activateSkill, identityOf, readSkillResource, type LoadedSkill, type PackageDescriptor, type SkillSource} from './loader';
import {isPositioningWorkflow} from '../opc/positioningWorkflow';
import {parseWorkflowManifest, workflowManifestPath, type WorkflowManifest} from './workflowManifest';

/*
 * Owner 2026-10-13 (AGENT-CORE R8b): only positioning runs as a guided step flow. Any other Skill is used
 * inside free chat, where the steps its workflow.yaml declares are an ordered work guide for the model,
 * not a workspace with confirmations. Without this the steps never reached the model (only SKILL.md did).
 */
// 32 steps of at most 160-character titles always fit; field details are shortened first.
export const STEP_GUIDE_MAX_CHARS = 8000;
const GUIDE_HEADER = 'Work guide declared by this Skill. Follow the steps in order inside the conversation; they are not '
  + 'separate screens and need no confirmation cards. Ask only for what the current step still needs, '
  + 'and skip what the user already gave.';

export function stepGuideText(manifest: WorkflowManifest): string | undefined {
  // Positioning is the one guided flow, by the same rule as the positioning entry (and migration 0219).
  if (isPositioningWorkflow(manifest)) return undefined;
  // Every step stays; when too long, drop field descriptions, then field titles.
  for (const detail of ['full', 'titles', 'steps'] as const) {
    const lines = manifest.steps.map((step, index) => {
      const fields = detail === 'steps' ? [] : (step.information ?? []).map(field =>
        `   - ${field.title}${detail === 'full' && field.description ? '：' + field.description : ''}`);
      return [`${index + 1}. ${step.title}`, ...fields].join('\n');
    });
    const text = GUIDE_HEADER + '\n' + lines.join('\n');
    if (text.length <= STEP_GUIDE_MAX_CHARS || detail === 'steps') return text;
  }
  return undefined;
}

/** The step work of a non-positioning Skill: the guide text and the files its steps declare, in order. */
export type StepWork = {guide: string; resources: string[]};

/** The immutable package, not today's module version, is the authority (same as the R3 organizer template). */
export async function loadStepWork(source: SkillSource, descriptor: PackageDescriptor): Promise<StepWork | undefined> {
  // Treat a descriptor without a file list as one without workflow.yaml.
  if (!(descriptor.files ?? []).some(item => item.path === workflowManifestPath)) return undefined;
  const manifest = parseWorkflowManifest(await readSkillResource(source, identityOf(descriptor), workflowManifestPath, 2 * 1024 * 1024));
  const guide = stepGuideText(manifest);
  if (guide === undefined) return undefined;
  const resources = [...new Set([...manifest.steps.flatMap(step => step.resources), ...(manifest.planResources ?? [])])]
    .filter(path => path !== 'SKILL.md').slice(0, 64);
  return {guide, resources};
}

/**
 * Free chat activation of a Skill: SKILL.md, plus for a non-positioning Skill its steps' declared files and the
 * ordered guide. When those files do not fit in half the budget, fall back to SKILL.md and the guide rather than refusing
 * the Skill; positioning and packages without workflow.yaml load exactly as before.
 */
export async function activateFreeChatSkill(source: SkillSource, descriptor: PackageDescriptor,
  options: {task?: string; maxContextBytes: number}): Promise<{loaded: LoadedSkill; instructions: string}> {
  const work = options.task === undefined ? await loadStepWork(source, descriptor) : undefined;
  let loaded: LoadedSkill | undefined;
  if (work?.resources.length) {
    // The steps' files may use at most half the budget, leaving room for the guide, the input and tools.
    const budget = Math.max(1, Math.floor(options.maxContextBytes / 2));
    try { loaded = await activateSkill(source, identityOf(descriptor), {resources: work.resources, maxContextBytes: budget}); }
    catch (error) { if (!String((error as Error)?.message).includes('CAPACITY_EXCEEDED')) throw error; }
  }
  loaded ??= await activateSkill(source, identityOf(descriptor), options);
  return {loaded, instructions: work ? loaded.forModel() + '\n' + work.guide : loaded.forModel()};
}
