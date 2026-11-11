'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Suspense } from 'react';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { ConnectView } from './connect-view';

/** PUBLISH-MONITOR PR-2b-2: the account confirmation step, in the workbench frame like the data review page it returns to. */
export default function Page() {
  return <WorkspaceFrame area="review"><Suspense><ConnectView /></Suspense></WorkspaceFrame>;
}
