/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// DB-100: runtime.choices (offered models + visible Skills) costs the database about 20 reads and
// changes only when an admin edits models/settings or the account's membership changes.
// Both of those places invalidate it, so a few minutes of client cache is safe.
export const RUNTIME_CHOICES_STALE_MS = 5 * 60_000;

// Admin-side writes that can change the offered models or visible Skills. A successful call from any of
// these routers marks runtime.choices stale in this browser; other browsers pick it up within the stale time.
const CHOICE_AFFECTING_ROUTERS = new Set([
  'settings', 'model', 'modelReasoning', 'modelPricing', 'modelIdentity', 'mentorBudget', 'reportModel',
  'fusionSettings', 'platformSecrets', 'skills', 'modules', 'skillTranslations', 'admin',
]);

/** `mutationKey` as tRPC builds it: `[[router, procedure]]`. */
export function mutationAffectsRuntimeChoices(mutationKey: unknown): boolean {
  const path = Array.isArray(mutationKey) ? mutationKey[0] : undefined;
  return Array.isArray(path) && typeof path[0] === 'string' && CHOICE_AFFECTING_ROUTERS.has(path[0]);
}
