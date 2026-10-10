/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent, TabsTrigger } from '@/components/ui/tabs';
import { StopNewCallsControl } from './StopNewCallsControl';
import { StopLossLimitsForm } from './StopLossLimitsForm';
import { ProviderBalanceForm } from './ProviderBalanceForm';
import { StopLossAlertList } from './StopLossAlertList';

export const STOP_LOSS_TAB = 'runtime-stop-loss';

export function RuntimeStopLossTabTrigger() {
  return <TabsTrigger value={STOP_LOSS_TAB} data-testid="admin-settings-stop-loss-tab"
    className="shrink-0 gap-2 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black">
    成本止损
  </TabsTrigger>;
}

/** Admin card for RUNTIME-PROD daily stop-loss; every block saves on its own. */
export function RuntimeStopLossSettings() {
  return <TabsContent value={STOP_LOSS_TAB}>
    <Card>
      <CardHeader>
        <CardTitle>成本止损</CardTitle>
        <CardDescription>
          本页每一块单独保存，页面的“保存所有设置”不包含这里。金额都是供应商实际美元成本，按 UTC 日统计。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <StopNewCallsControl />
        <StopLossLimitsForm />
        <ProviderBalanceForm />
        <StopLossAlertList />
      </CardContent>
    </Card>
  </TabsContent>;
}
