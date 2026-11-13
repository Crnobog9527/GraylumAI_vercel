'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { IntegrationsView } from '@/components/integrations/IntegrationsView';

/** INTEGRATION-SHOTVIVA PR C (Owner 2026-11-12): the integrations page, reached from the phone's 功能 page (and, after PR D, the rail). */
export default function IntegrationsPage() {
  return <WorkspaceFrame area="tools"><Suspense fallback={null}><WithResult/></Suspense></WorkspaceFrame>;
}

function WithResult() {
  const params = useSearchParams();
  return <IntegrationsView result={{ connected: params.get('shotviva'), error: params.get('shotviva_error') }}/>;
}
