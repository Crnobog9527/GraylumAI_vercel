/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * A workflow the positioning entry can start: every step declares information fields and at
 * least one field feeds the positioning profile. The database guard that keeps the POSITIONING-GATE
 * flag off the positioning Skill (opc_is_positioning_workflow, migration 0219) applies the same rule.
 */
export function isPositioningWorkflow(workflow: unknown): boolean {
  const steps = (workflow as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || !steps.length) return false;
  const fields = (step: unknown) => (step as { information?: unknown } | null)?.information;
  return steps.every(step => Array.isArray(fields(step)) && (fields(step) as unknown[]).length > 0)
    && steps.some(step => (fields(step) as unknown[]).some(field => {
      const key = (field as { profileKey?: unknown } | null)?.profileKey;
      return typeof key === 'string' && key !== '';
    }));
}
