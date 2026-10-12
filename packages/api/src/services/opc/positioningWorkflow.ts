/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * A workflow the positioning entry can start: every step declares information fields and at
 * least one field feeds the positioning profile. The positioning catalog and the POSITIONING-GATE
 * Skill flag use this one rule, so the Skill users need to create a positioning is never gated.
 */
export function isPositioningWorkflow(workflow: unknown): boolean {
  const steps = (workflow as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || !steps.length) return false;
  const fields = (step: unknown) => (step as { information?: unknown } | null)?.information;
  return steps.every(step => Array.isArray(fields(step)) && (fields(step) as unknown[]).length > 0)
    && steps.some(step => (fields(step) as unknown[]).some(field => Boolean((field as { profileKey?: unknown } | null)?.profileKey)));
}
