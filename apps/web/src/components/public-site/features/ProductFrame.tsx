/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { AsDemo } from '@/components/chat-display/display-heading';
import light from '@/components/design/light-tokens.module.css';
import { cn } from '@/lib/utils';

/**
 * The light product surface the real display components are drawn on (they read the product's light tokens),
 * with a caption saying the content is made-up example data. Used by the feature pages; the components inside
 * are the product's own (`components/chat-display`, `components/library`, `components/landing/preview-jury`).
 */
export function ProductFrame({ label, caption, className, children }: {
  label: string;
  caption: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className="m-0">
      <div
        role="group" aria-label={label}
        className={cn(
          light.light, 'overflow-hidden rounded-2xl border border-[#2B2B2B] bg-[var(--gl-canvas)] p-3',
          'text-[var(--gl-text)] sm:p-5', className,
        )}
      >
        <AsDemo>{children}</AsDemo>
      </div>
      <figcaption className="mt-3 text-center text-xs text-[#8A8A8A]">{caption}</figcaption>
    </figure>
  );
}
