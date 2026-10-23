'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { DataReviewView } from '@/components/publish-monitor/DataReviewView';

/** PUBLISH-MONITOR PR-7: the "数据复盘" page (accounts, own post data, table import, weekly reviews). */
export default function PublishMonitorPage() {
  return <WorkspaceFrame area="review"><DataReviewView /></WorkspaceFrame>;
}
