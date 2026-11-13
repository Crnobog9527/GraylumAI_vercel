/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { z } from 'zod';

/** VOICE-2 PR-4: the 文风 2.0 switch (system_settings voice_examples) is a plain boolean; anything else would read as "on". */
export function validateVoiceExamplesSetting(setting: { key: string; value: unknown }, ctx: z.RefinementCtx) {
  if (setting.key === 'voice_examples' && typeof setting.value !== 'boolean') {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '文风 2.0 开关只能是打开或关闭' });
  }
}
