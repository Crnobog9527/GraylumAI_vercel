/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { STALE_WORKSPACE_NOTICE } from './topic-notices';

/**
 * Shown over a topic workspace whose positioning version is behind the current formal one; the workspace is read-only.
 * The way out is explicit: start the topic work again on the latest positioning (the old conversation stays to read).
 */
export function StaleWorkspaceNotice({ draftId, busy, onStart }: { draftId: string; busy: boolean; onStart: () => void }) {
  return (
    <p role="status" className="border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3 text-center text-sm">
      {STALE_WORKSPACE_NOTICE}
      <button type="button" className="ml-2 underline" disabled={busy} onClick={onStart}>用最新定位开始选题</button>
      <Link className="ml-2 underline" href={`/app/positioning/${draftId}`}>查看最新定位</Link>
    </p>
  );
}
