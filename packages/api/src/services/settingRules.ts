/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { z } from 'zod';
import { validateSignupGiftSetting } from './signupGuard/settings';
import { validateVoiceExamplesSetting } from './voice/setting';

/** The per-key value rules of a system setting write that live outside the settings router (it is at its size limit). */
export function validateSettingRules(setting: { key: string; value: unknown }, ctx: z.RefinementCtx) {
  validateSignupGiftSetting(setting, ctx);
  validateVoiceExamplesSetting(setting, ctx);
}
