/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { libraryTabFromParam, libraryTabParam } from './library-tab';

it('keeps the documents and evidence tabs in the URL and reopens them', () => {
  for (const tab of ['documents', 'voice', 'evidence'] as const) expect(libraryTabFromParam(libraryTabParam(tab))).toBe(tab);
  expect(libraryTabParam('topics')).toBeNull();
  expect(libraryTabFromParam(null)).toBe('topics');
  expect(libraryTabFromParam('other')).toBe('topics');
});
