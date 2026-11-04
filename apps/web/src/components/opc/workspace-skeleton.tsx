/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';

/**
 * A page still reading its data, drawn inside the same frame as the finished page (light background, sidebar, header). A bare
 * skeleton under the app's dark body flashed black on a slow connection (UI-FINISH). No words; the label is for screen readers.
 */
export function WorkspaceSkeleton({ area, label }: { area: 'chat' | 'topics'; label: string }) {
  return <WorkspaceFrame area={area}><main><PageSkeleton rows={6} label={label} /></main></WorkspaceFrame>;
}
