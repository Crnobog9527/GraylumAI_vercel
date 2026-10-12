/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {identityOf, readSkillResource, type SkillSource} from './loader';
import {parseWorkflowManifest, workflowManifestPath, type WorkflowManifest} from './workflowManifest';

/*
 * Owner 2026-10-13 (AGENT-CORE R8b): only positioning runs as a guided step flow. Any other Skill is used
 * inside free chat, where the steps its workflow.yaml declares are an ordered work guide for the model,
 * not a workspace with confirmations. Without this the steps never reached the model (only SKILL.md did).
 */
export const STEP_GUIDE_MAX_CHARS = 4000;

/** Positioning is the one guided flow: a declared field feeds the positioning profile. */
export function isGuidedPositioning(manifest: WorkflowManifest): boolean {
  return manifest.steps.some(step => step.information?.some(field => field.profileKey !== undefined));
}

export function stepGuideText(manifest: WorkflowManifest): string | undefined {
  if (isGuidedPositioning(manifest)) return undefined;
  const lines = manifest.steps.map((step, index) => {
    const fields = (step.information ?? []).map(field =>
      `   - ${field.title}${field.description ? '：' + field.description : ''}`);
    return [`${index + 1}. ${step.title}`, ...fields].join('\n');
  });
  const text = 'Work guide declared by this Skill. Follow the steps in order inside the conversation; they are not '
    + 'separate screens and need no confirmation cards. Ask only for what the current step still needs, '
    + 'and skip what the user already gave.\n' + lines.join('\n');
  return text.length > STEP_GUIDE_MAX_CHARS ? text.slice(0, STEP_GUIDE_MAX_CHARS) : text;
}

/** The immutable package, not today's module version, is the authority (same as the R3 organizer template). */
export async function loadStepGuide(source: SkillSource, revisionId: string): Promise<string | undefined> {
  const descriptor = (await source.list()).find(item => item.revisionId === revisionId);
  if (!descriptor) throw new Error('RUNTIME_REVISION_DENIED');
  // Treat a descriptor without a file list as one without workflow.yaml.
  if (!(descriptor.files ?? []).some(item => item.path === workflowManifestPath)) return undefined;
  return stepGuideText(parseWorkflowManifest(
    await readSkillResource(source, identityOf(descriptor), workflowManifestPath, 2 * 1024 * 1024)));
}
