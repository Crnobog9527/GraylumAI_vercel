/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** The coach as it appears in the illustrations (a coral speech bubble with eyes), small. Decorative. */
export function CoachMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true" focusable="false">
      <path d="M4 18 C4 9 11 4 20 4 C29 4 36 9 36 18 C36 27 29 32 20 32 L13 32 L7 38 L8 30 C5 27 4 23 4 18 Z"
        fill="#ff6b4a" stroke="#23304d" strokeWidth="2.6" strokeLinejoin="round" />
      <circle cx="14" cy="16" r="2.4" fill="#23304d" />
      <circle cx="26" cy="16" r="2.4" fill="#23304d" />
      <path d="M15 22 Q20 26 25 22" fill="none" stroke="#23304d" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
