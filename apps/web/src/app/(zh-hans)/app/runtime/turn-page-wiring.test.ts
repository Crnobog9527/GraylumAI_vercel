/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A conversation page on useTurnChat must keep the turn's freeze out of the sidebar balance and take a stored send's put-back text out of the
// box after a reload (a work item's page once did neither). Found by reading the page files, so a new page cannot leave them out.
describe('every page on useTurnChat', () => {
  const pages = readdirSync(__dirname).filter(name => /\.tsx$/.test(name) && !/\.test\./.test(name))
    .map(name => ({ name, source: readFileSync(join(__dirname, name), 'utf8') })).filter(page => page.source.includes('useTurnChat('));
  it('is found', () => {
    expect(pages.map(page => page.name)).toEqual(expect.arrayContaining(['turn-workspace.tsx', 'work-item-workspace.tsx']));
  });
  for (const page of pages)
    it(`${page.name}: tells the sidebar the turn is running and clears a stored send`, () => {
      expect(page.source).toContain('turnBusy={chat.creditsBusy}');
      expect(page.source).toContain('useStoredSendCleanup(');
    });
});
