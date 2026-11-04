/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * MEMBER-ONLY-MODULES (Owner 2026-11-04): a Skill limited to members is shown to everyone with a note, and a free user who tries to use
 * it meets the paywall. `required_member_level` is the lowest level that may use it ('pro' = Pro and Gold, 'gold' = Gold; null = all).
 */
export type RequiredMemberLevel = 'pro' | 'gold';
const RANK: Record<string, number> = { free: 0, pro: 1, gold: 2 };

export const asRequiredLevel = (value: unknown): RequiredMemberLevel | null => (value === 'pro' || value === 'gold' ? value : null);

/** An unknown or loading plan counts as free; an unknown requirement is never met. */
export function meetsMemberLevel(level: string | null | undefined, required: string | null | undefined): boolean {
  if (!required) return true;
  return (RANK[level ?? 'free'] ?? 0) >= (RANK[required] ?? Number.POSITIVE_INFINITY);
}

/** The note shown beside a member-only module. */
export const memberOnlyNote = (required: RequiredMemberLevel): string => (required === 'gold' ? '会员专享 · Gold 可用' : '会员专享 · Pro 和 Gold 可用');

/** What a member who uses the coach from the marketplace finds typed in the chat input (the only member-only Skill so far). */
export const MEMBER_ONLY_PREFILL = '帮我复盘';
/** The start page reads this once into its input (positioning/page.tsx); the member then only has to send it. */
export const NEW_TASK_INPUT_KEY = 'opc-new-task-input';
export function prefillNewTask(text: string): void {
  try { sessionStorage.setItem(NEW_TASK_INPUT_KEY, text); } catch { /* storage unavailable: the chat just opens empty */ }
}
