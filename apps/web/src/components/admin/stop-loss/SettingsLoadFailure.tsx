/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import AdminErrorState from '@/components/admin/AdminErrorState';
import { StopNewCallsControl } from './StopNewCallsControl';

/**
 * Settings-page load failure. The emergency stop has its own queries, so it stays usable
 * even when the rest of the settings dashboard cannot load.
 */
type LoadError = Parameters<typeof AdminErrorState>[0]['error'];
export function SettingsLoadFailure({ error, onRetry }: { error: LoadError; onRetry: () => void }) {
  return <div className="space-y-6">
    <AdminErrorState error={error} onRetry={onRetry} />
    <div className="px-4 pb-4 md:px-8 md:pb-8"><StopNewCallsControl /></div>
  </div>;
}
