/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * A placeholder for a block that is still being read: grey bars, no words. Static (no hooks, no data), so it can also be a Suspense fallback.
 * Screen readers get `aria-busy` and a label; nothing visible says "loading". `compact` is the same without the padding and the title bar,
 * for a block inside something else (a menu, a dialog, a list).
 */
export function PageSkeleton({ rows = 4, label = '内容读取中', composer = false, compact = false }: {
  rows?: number; label?: string; composer?: boolean; compact?: boolean;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} data-testid="page-skeleton"
      className={`flex w-full flex-col gap-3 ${compact ? 'py-1' : 'h-full p-6'}`}>
      {!compact && <div className="skeleton skeleton-title" />}
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton skeleton-text" style={{ width: `${92 - ((index * 17) % 40)}%`, marginBottom: 0 }} />
      ))}
      {/* Where the input box will be, so the page does not jump when the conversation arrives. */}
      {composer && <div className="skeleton mt-auto h-14 w-full rounded-xl" />}
    </div>
  );
}
