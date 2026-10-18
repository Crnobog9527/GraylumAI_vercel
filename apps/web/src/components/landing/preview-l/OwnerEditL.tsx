/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { OwnerEditJ } from '@/components/landing/preview-j/OwnerEditJ';
import { demoCopyGroupsL } from './demo-copy-l';

/**
 * Sample L's "改字模式" (Owner 2026-10-18), sample J's edit mode with L's demo copy and the export of the whole list.
 * Mounted only by the /landing/preview/l page in a development server: never by SampleL itself, so the live /landing
 * page built from it can never carry it.
 */
export function OwnerEditL() {
  return <OwnerEditJ groups={demoCopyGroupsL} exportable />;
}
