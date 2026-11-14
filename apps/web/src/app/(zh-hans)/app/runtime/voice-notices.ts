/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** VOICE-2 PR-3: said under a reply whose sentences copied from the user's past passages were rewritten before it was saved. */
export const VOICE_REVISED = 'VOICE_REVISED';
export const voiceRevisedNotice = (count: number) => `有 ${count} 句和你的旧稿太像，已经换了说法。`;
