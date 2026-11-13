/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** VOICE-2 PR-2: the administrator's switch for the writing stats and examples (system_settings voice_examples, read with the
 * admission's settings in readAdmissionConfiguration). `false` falls back to voice-v3; missing or unreadable means on. */
export const VOICE_EXAMPLES_SETTING = 'voice_examples';
export const voiceExamplesOn = (value: unknown) => value !== false;
