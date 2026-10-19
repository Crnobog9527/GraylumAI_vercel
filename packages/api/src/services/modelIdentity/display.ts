/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * MODEL-IDENTITY-GUARD layer 4: what a user-facing response may say about a model.
 *
 * Responses carry only the opaque ai_models.id and a "模型 A/B/C…" label in list order, never
 * a real name, model_id, provider or route tag. Owner 2026-10-12: hiding real names in
 * server-browser data always applies, whatever the switch (the switch governs layers 1-3).
 *
 * Whitelist: the Fusion multi-model review panel (评审团) may always show real names, and so may the multi-model
 * compare picker and its columns (Owner 2026-10-17: "显示后台配置的真实模型名称").
 * A Fusion procedure must pass FUSION_REVIEW_SURFACE / FUSION_COMPARE_SURFACE explicitly; nothing else may.
 */
export const FUSION_REVIEW_SURFACE = 'fusion_review' as const;
export const FUSION_COMPARE_SURFACE = 'fusion_compare' as const;
export type ModelSurface = 'user' | typeof FUSION_REVIEW_SURFACE | typeof FUSION_COMPARE_SURFACE;

export function modelAlias(index: number) {
  return index < 26 ? `模型 ${String.fromCharCode(65 + index)}` : `模型 ${index + 1}`;
}

export function publicModelChoices(models: ReadonlyArray<{ id: string; name: string }>,
  options: { surface: ModelSurface }) {
  const real = options.surface === FUSION_REVIEW_SURFACE || options.surface === FUSION_COMPARE_SURFACE;
  return models.map((model, index) => ({ id: model.id, label: real ? model.name : modelAlias(index) }));
}
