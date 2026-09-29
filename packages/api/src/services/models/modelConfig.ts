/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** `ai_models.config` also holds connection-test state. Every writer other
 * than the reasoning-settings procedures keeps the stored `reasoning` key
 * as it is, so a generic config write can neither drop nor forge it. */
export function withStoredReasoning(next: Record<string, unknown>, current: unknown): Record<string, unknown> {
  const { reasoning: _ignored, ...rest } = next;
  const stored = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>).reasoning : undefined;
  return stored === undefined ? rest : { ...rest, reasoning: stored };
}
