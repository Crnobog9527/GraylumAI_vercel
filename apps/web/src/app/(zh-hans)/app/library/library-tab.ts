/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export type LibraryTab = 'topics' | 'documents' | 'voice' | 'evidence';

/** The tab a `?tab=` value reopens; anything else is the default topics tab. */
export const libraryTabFromParam = (value: string | null): LibraryTab =>
  value === 'documents' || value === 'voice' || value === 'evidence' ? value : 'topics';

/** The `?tab=` value that keeps a tab across refresh and shared links; null removes it (topics). */
export const libraryTabParam = (tab: LibraryTab): string | null => (tab === 'topics' ? null : tab);
