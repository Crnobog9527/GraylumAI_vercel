/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readinessNote, type ModelPriceView } from './modelReportPricing';

/** "Can be saved, cannot be called yet" notice for a model without a usable price (plan 3.2 item 3). */
export function ModelReadinessNote({ priceView }: { priceView: ModelPriceView | null }) {
  const note = readinessNote(priceView);
  return note ? <p className="text-xs text-amber-400" data-testid="model-readiness-note">{note}</p> : null;
}
