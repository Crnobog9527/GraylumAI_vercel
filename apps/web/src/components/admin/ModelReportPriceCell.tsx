/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { priceCell, type ModelPriceView, type PriceCellKind } from './modelReportPricing';

/** Finance / performance table cell for one OpenRouter snapshot price (read-only). */
export function ModelReportPriceCell({ pricing, kind }: { pricing: ModelPriceView; kind: PriceCellKind }) {
  const cell = priceCell(pricing, kind);
  const readAt = pricing.fetchedAt ? `价格读取于 ${new Date(pricing.fetchedAt).toLocaleString()}` : undefined;
  return (
    <div className="text-sm" title={readAt} data-price-kind={kind}>
      <div style={{ color: cell.known ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{cell.main}</div>
      {cell.details.map(detail => (
        <div key={detail} className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{detail}</div>
      ))}
    </div>
  );
}
