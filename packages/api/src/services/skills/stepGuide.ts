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

export function stepGuideText(manifest: WorkflowManifest, maxBytes = Number.POSITIVE_INFINITY): string | undefined {
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
    if (text.length <= STEP_GUIDE_MAX_CHARS && Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  }
  // Not even the step titles fit: no guide, the Skill loads as before.
  return undefined;
}

/** The step work of a non-positioning Skill: the guide text and the files its steps declare, in order. */
export type StepWork = {guide: string; resources: string[]};
/** A2: the saved content this Skill derives from (workflow.yaml `contentSource`). */
export type ContentSourceKind = NonNullable<WorkflowManifest['contentSource']>;

/** The immutable package, not today's module version, is the authority (same as the R3 organizer template). */
export async function loadStepWork(source: SkillSource, descriptor: PackageDescriptor,
  maxGuideBytes = Number.POSITIVE_INFINITY): Promise<StepWork | undefined> {
  const manifest = await readStepManifest(source, descriptor);
  return manifest && stepWorkOf(manifest, maxGuideBytes);
}
/** A3a: the guided positioning Skill starts only from the positioning entry, never from free chat matching. */
export async function isPositioningPackage(source: SkillSource, descriptor: PackageDescriptor): Promise<boolean> {
  const manifest = await readStepManifest(source, descriptor);
  return Boolean(manifest && isPositioningWorkflow(manifest));
}
async function readStepManifest(source: SkillSource, descriptor: PackageDescriptor): Promise<WorkflowManifest | undefined> {
  // Treat a descriptor without a file list as one without workflow.yaml.
  if (!(descriptor.files ?? []).some(item => item.path === workflowManifestPath)) return undefined;
  return parseWorkflowManifest(await readSkillResource(source, identityOf(descriptor), workflowManifestPath, 2 * 1024 * 1024));
}
function stepWorkOf(manifest: WorkflowManifest, maxGuideBytes: number): StepWork | undefined {
  const guide = stepGuideText(manifest, maxGuideBytes);
  if (guide === undefined) return undefined;
  const resources = [...new Set([...manifest.steps.flatMap(step => step.resources), ...(manifest.planResources ?? [])])]
    .filter(path => path !== 'SKILL.md').slice(0, 64);
  return {guide, resources};
}

/**
 * Free chat activation of a Skill: SKILL.md, plus for a non-positioning Skill its steps' declared files and the
 * ordered guide. When those files do not fit their share, fall back to SKILL.md and the guide rather than refusing
 * the Skill; positioning and packages without workflow.yaml load exactly as before.
 */
export async function activateFreeChatSkill(source: SkillSource, descriptor: PackageDescriptor,
  options: {task?: string; maxContextBytes: number; withResources?: boolean}):
  Promise<{loaded: LoadedSkill; instructions: string; contentSource?: ContentSourceKind}> {
  // Bounded shares keep room for the user input, history and tools, which are sized later in admission:
  // the guide at most 1/8 of the budget, the steps' files at most 1/4.
  // A package with legacy tasks keeps its mandatory task selection: never reach it through workflow resources.
  const taskPackage = Object.keys(descriptor.tasks ?? {}).length > 0;
  const manifest = options.task === undefined && !taskPackage ? await readStepManifest(source, descriptor) : undefined;
  // Positioning never derives from saved content (it is the guided flow, not a free chat Skill).
  const contentSource = manifest && !isPositioningWorkflow(manifest) ? manifest.contentSource : undefined;
  const sourced = contentSource ? {contentSource} : {};
  const work = manifest && stepWorkOf(manifest, Math.floor(options.maxContextBytes / 8));
  const capacity = (error: unknown) => String((error as Error)?.message).includes('CAPACITY_EXCEEDED');
  if (work) {
    // The guide is appended after loading, so its bytes come out of the budget first.
    const rest = options.maxContextBytes - Buffer.byteLength('\n' + work.guide, 'utf8');
    const attempts = [
      ...(work.resources.length && options.withResources !== false
        ? [{resources: work.resources, maxContextBytes: Math.floor(options.maxContextBytes / 4)}] : []),
      {maxContextBytes: rest},
    ].filter(attempt => attempt.maxContextBytes >= 1);
    for (const attempt of attempts) {
      try {
        const loaded = await activateSkill(source, identityOf(descriptor), attempt);
        return {loaded, instructions: loaded.forModel() + '\n' + work.guide, ...sourced};
      } catch (error) { if (!capacity(error)) throw error; }
    }
  }
  // No guide, or not even SKILL.md and the guide fit: load exactly as before.
  const loaded = await activateSkill(source, identityOf(descriptor), {task: options.task, maxContextBytes: options.maxContextBytes});
  return {loaded, instructions: loaded.forModel(), ...sourced};
}
