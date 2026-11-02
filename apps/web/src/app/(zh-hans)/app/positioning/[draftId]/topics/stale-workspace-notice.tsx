/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { STALE_WORKSPACE_NOTICE } from './topic-notices';

/** Shown over a topic workspace whose positioning version is behind the current formal one; the workspace is read-only. */
export function StaleWorkspaceNotice({ draftId }: { draftId: string }) {
  return (
    <p role="status" className="border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3 text-center text-sm">
      {STALE_WORKSPACE_NOTICE}<Link className="ml-2 underline" href={`/app/positioning/${draftId}`}>查看最新定位</Link>
    </p>
  );
}
