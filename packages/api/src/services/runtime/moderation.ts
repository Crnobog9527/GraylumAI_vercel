/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export type ModerationVerdict = { action: 'allow' } | { action: 'block'; category: string };
export type ModerationInput = {
  actorId: string; sessionId: string; requestId: string; text: string; opening: boolean;
};
export type ModerationOutput = {
  actorId: string; executionId: string; body: string; summary?: string;
};
/** Implementations should not throw; the host treats an exception as a block. */
export interface RuntimeModeration {
  checkInput(input: ModerationInput): Promise<ModerationVerdict>;
  checkOutput(output: ModerationOutput): Promise<ModerationVerdict>;
}
/** Placeholder only: no network, configuration, persistence or content decisions. */
export const allowAllModeration: RuntimeModeration = {
  checkInput: async () => ({ action: 'allow' }),
  checkOutput: async () => ({ action: 'allow' }),
};

export async function requireAllowedInput(input: ModerationInput): Promise<void> {
  let allowed = false;
  try { allowed = (await allowAllModeration.checkInput(input)).action === 'allow'; }
  catch { /* Exceptions have the same verdict as a block. */ }
  if (!allowed) throw new Error('RUNTIME_MODERATION_BLOCKED');
}

export async function allowedOutput(output: ModerationOutput): Promise<boolean> {
  try { return (await allowAllModeration.checkOutput(output)).action === 'allow'; }
  catch { return false; }
}
