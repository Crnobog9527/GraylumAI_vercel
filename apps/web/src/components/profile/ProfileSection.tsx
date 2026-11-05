/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties, ReactNode } from 'react';

/**
 * The card container of the profile center (DESIGN.md "Card"): white, 1px border, 12px radius, no shadow.
 * The values carry their light fallbacks because a few cards render inside a Radix portal, outside the page
 * root that defines --gl-*.
 */
export function ProfileSection({ children, className = 'mb-6', style, ...rest }: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}) {
  return (
    <div
      {...rest}
      className={`p-5 md:p-6 ${className}`}
      style={{
        background: 'var(--gl-surface, #fff)',
        border: '1px solid var(--gl-border, #ededed)',
        borderRadius: 'var(--gl-radius-card, 12px)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
