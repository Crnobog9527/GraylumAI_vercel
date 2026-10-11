/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * MODEL-IDENTITY-GUARD layer 4: what a user-facing response may say about a model.
 *
 * Responses carry only the opaque ai_models.id and a display label, never model_id,
 * provider or route tags. With the switch on the label is "模型 A/B/C…" in list order;
 * with it off (Owner 2026-10-12) the label is the administrator-entered ai_models.name.
 *
 * Whitelist: the Fusion multi-model review panel (评审团) may always show real names.
 * A Fusion procedure must pass FUSION_REVIEW_SURFACE explicitly; nothing else may.
 */
export const FUSION_REVIEW_SURFACE = 'fusion_review' as const;
export type ModelSurface = 'user' | typeof FUSION_REVIEW_SURFACE;

export function modelAlias(index: number) {
  return index < 26 ? `模型 ${String.fromCharCode(65 + index)}` : `模型 ${index + 1}`;
}

export function publicModelChoices(models: ReadonlyArray<{ id: string; name: string }>,
  options: { guardEnabled: boolean; surface: ModelSurface }) {
  const real = options.surface === FUSION_REVIEW_SURFACE || !options.guardEnabled;
  return models.map((model, index) => ({ id: model.id, label: real ? model.name : modelAlias(index) }));
}
