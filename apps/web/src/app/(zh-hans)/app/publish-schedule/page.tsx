'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { ScheduleView } from '@/components/publish-schedule/ScheduleView';

/** PUBLISH-SCHEDULE: the "发布排期" page (scheduled, sent, failed and cancelled posts of a week). */
export default function PublishSchedulePage() {
  return <WorkspaceFrame area="schedule"><ScheduleView /></WorkspaceFrame>;
}
