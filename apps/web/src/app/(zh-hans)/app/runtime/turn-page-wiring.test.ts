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

// A turn that closes while another conversation's turn still holds its freeze reads a low balance, and nothing else asks again: every close
// goes through one `settle` (a read now, one later), and coming back to the window reads too. No settled.current() outside those.
describe('useTurnChat balance reads', () => {
  const source = readFileSync(join(__dirname, 'use-turn-chat.ts'), 'utf8');
  it('reads again after a close and when the window is back', () => {
    expect(source).toContain('REREAD_MS');
    expect(source).toContain("addEventListener('focus'");
    expect(source).toContain('announceTurnClosed()');
    expect(source).toContain('onTurnClosed(');
    expect(source.match(/settled\.current\(\)/g)).toHaveLength(4);
  });
});

// Owner 2026-11-02: a work item's page opened with ?continue offers "继续中断的工作" and never sends by itself. The guide (a paid turn) starts
// only from a click, once: continueWork() removes ?continue before it sends, so a refresh offers nothing and sends nothing.
describe('a work item opened with ?continue', () => {
  const source = readFileSync(join(__dirname, 'work-item-workspace.tsx'), 'utf8');
  it('offers the button and starts the guide only from the click', () => {
    expect(source).toContain('继续中断的工作');
    expect(source.match(/void guide\(\)/g)).toHaveLength(2);
    const click = source.slice(source.indexOf('function continueWork()'), source.indexOf('const messages = chat.view'));
    expect(click.indexOf("searchParams.delete('continue')")).toBeGreaterThan(-1);
    expect(click.indexOf("searchParams.delete('continue')")).toBeLessThan(click.indexOf('void guide()'));
    // The page-open effect only reads the address; no effect starts the guide.
    const effects = source.slice(source.indexOf("setContinueOffered(new URL"), source.indexOf('const canContinue'));
    expect(effects).not.toContain('guide(');
  });
});
