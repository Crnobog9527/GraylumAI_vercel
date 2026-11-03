/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * A placeholder for a block that is still being read: grey bars, no words. Static (no hooks, no data), so it can also be a Suspense fallback.
 * Screen readers get `aria-busy` and a label; nothing visible says "loading".
 */
export function PageSkeleton({ rows = 4, label = '内容读取中', composer = false }: { rows?: number; label?: string; composer?: boolean }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex h-full w-full flex-col gap-3 p-6" data-testid="page-skeleton">
      <div className="skeleton skeleton-title" />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton skeleton-text" style={{ width: `${92 - ((index * 17) % 40)}%` }} />
      ))}
      {/* Where the input box will be, so the page does not jump when the conversation arrives. */}
      {composer && <div className="skeleton mt-auto h-14 w-full rounded-xl" />}
    </div>
  );
}
