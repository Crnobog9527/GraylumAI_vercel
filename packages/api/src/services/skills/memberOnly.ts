/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * MEMBER-ONLY-MODULES (Owner 2026-11-04): a Skill limited to members stays visible to everyone; `modules.required_member_level` is the
 * lowest membership level that may use it (null = everyone, 'pro' = Pro and Gold, 'gold' = Gold). Levels are the entitlement names.
 */
export type RequiredMemberLevel = 'pro' | 'gold';
const RANK: Record<string, number> = { free: 0, pro: 1, gold: 2 };

/** `level` null/unknown counts as free; an unknown requirement is never met (fails closed). */
export function meetsMemberLevel(level: string | null | undefined, required: string | null | undefined): boolean {
  if (!required) return true;
  return (RANK[level ?? 'free'] ?? 0) >= (RANK[required] ?? Number.POSITIVE_INFINITY);
}

export const asRequiredLevel = (value: unknown): RequiredMemberLevel | null => (value === 'pro' || value === 'gold' ? value : null);
