/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { ModelCapacityPanel } from './ModelCapacityPanel';
import { ModelFrozenPriceSummary } from './ModelFrozenPriceSummary';
import { ModelPriceSnapshotPanel } from './ModelPriceSnapshotPanel';
import { ModelReadinessNote } from './ModelReadinessNote';
import { useModelPriceUnits } from './useModelPriceUnits';
import { useModelCatalogRefresh } from './useModelCatalogRefresh';

/**
 * Read-only prices and capacity in the add / edit model form (plan 3.2 item 2),
 * replacing the removed manual cost fields. Everything comes from the server's
 * `modelReasoning.get` projection of the saved route. The "读取价格和容量" button runs the
 * same catalog read as the "思考设置" dialog; choosing the route stays in that dialog.
 */
export function ModelEditPriceSection(props: { modelId: string | null; open: boolean; onShowMultipliers: () => void }) {
  const { modelId, open, onShowMultipliers } = props;
  const view = trpc.modelReasoning.get.useQuery({ modelId: modelId ?? '' }, { enabled: open && Boolean(modelId) });
  const units = useModelPriceUnits(open ? modelId : null);
  const refresh = useModelCatalogRefresh(modelId ?? '');
  if (!modelId) {
    return (
      <section className="space-y-2" data-testid="model-edit-price">
        <ModelReadinessNote priceView={null} />
        <ModelCapacityPanel capacity={null} where="form" />
      </section>
    );
  }
  if (!view.data) {
    return <ModelCapacityPanel capacity={null} where="form" pending={view.error ? 'failed' : 'loading'} />;
  }
  const data = view.data;
  return (
    <section className="space-y-4 text-sm" data-testid="model-edit-price">
      <ModelReadinessNote priceView={data.priceView} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--text-tertiary)]">
          下面按已保存的线路 {data.config.route ?? '（未选择）'} 显示。读取按已保存的模型 ID 进行；改选线路请到这个模型的"思考设置"。
        </p>
        <Button type="button" variant="outline" size="sm" onClick={refresh.read} disabled={refresh.isPending}>
          {refresh.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
          读取价格和容量
        </Button>
      </div>
      {refresh.errorText ? <p role="alert" className="text-xs text-rose-400">{refresh.errorText}</p> : null}
      <ModelPriceSnapshotPanel
        pricing={data.pricing}
        route={data.config.route}
        modelId={data.model}
        catalogFetchedAt={data.config.catalog?.fetchedAt ?? null}
        changes={refresh.priceChanges}
        where="form"
      />
      <ModelFrozenPriceSummary
        priceView={data.priceView}
        selectedRoute={data.config.route}
        units={units}
        onShowMultipliers={onShowMultipliers}
      />
      <ModelCapacityPanel capacity={data.capacity} previous={refresh.previousCapacity} where="form" />
    </section>
  );
}
