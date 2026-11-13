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
  // The steps list (TURN-STEPS): the live reply shows the steps it has, and every saved reply shows the steps this page saw or the
  // server kept (so a reload still has them).
  for (const page of pages)
    it(`${page.name}: lists the steps of the live reply and of each saved reply`, () => {
      expect(page.source).toContain('<TurnStepList steps={chat.live?.steps ?? []} live');
      expect(page.source).toContain('chat.stepsByTurn.get(reply.turnId) ?? reply.steps ?? []');
    });
  // Owner 2026-11-13: a reply that only reports an image not made offers no save (offersSave, lib/session-results).
  for (const page of pages.filter(page => page.source.includes('<SaveReplyButton')))
    it(`${page.name}: offers a save only where offersSave allows it`, () => {
      expect(page.source).toContain('offersSave(reply.content, steps) && <SaveReplyButton');
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
