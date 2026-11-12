'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Suspense } from 'react';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { DataReviewView } from '@/components/publish-monitor/DataReviewView';

/** PUBLISH-MONITOR PR-7: the "数据复盘" page (accounts, own post data, table import, weekly reviews). */
export default function PublishMonitorPage() {
  // DataReviewView reads the address's search params (?tab=…): Next asks for a Suspense boundary around such a reader.
  return <WorkspaceFrame area="review"><Suspense><DataReviewView /></Suspense></WorkspaceFrame>;
}
