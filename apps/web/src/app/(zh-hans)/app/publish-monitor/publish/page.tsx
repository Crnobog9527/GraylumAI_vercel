'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Suspense } from 'react';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { PublishView } from './publish-view';

/** PUBLISH-MONITOR PR-5: one-click publishing, in the workbench frame like the data review page it belongs to. */
export default function Page() {
  return <WorkspaceFrame area="review"><Suspense><PublishView /></Suspense></WorkspaceFrame>;
}
