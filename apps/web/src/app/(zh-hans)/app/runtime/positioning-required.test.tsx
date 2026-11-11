/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import { readStartEntry } from '@/app/(zh-hans)/app/positioning/start-entry';
import { POSITIONING_REQUIRED_NOTICE } from './gate-notices';
import {
  POSITIONING_ACTIONS, POSITIONING_CARD_LABEL, existingPositioning, positioningEntryHref, positioningRequiredNotice,
} from './positioning-required';
import { turnCodeNotice } from './turn-notices';

// POSITIONING-GATE step 3: one guide card (start / import) on the turn path.
const html = (navigate = vi.fn()) => renderToStaticMarkup(createElement(ChatNoticeList, { notices: [positioningRequiredNotice('n', navigate)] }));

describe('positioning guide card', () => {
  it('renders the explanation, the not-charged note and both entries, without any code', () => {
    const markup = html();
    expect(markup).toContain(`aria-label="${POSITIONING_CARD_LABEL}"`);
    expect(markup).toContain('本次没有扣积分');
    expect(markup).toContain('>开始定位</button>');
    expect(markup).toContain('>导入已有定位</button>');
    expect(markup).not.toContain('POSITIONING_REQUIRED');
  });

  it('is the card the turn path shows for the refusal code: same text, so the page swaps the plain notice for the card', () => {
    const refused = turnCodeNotice('POSITIONING_REQUIRED');
    expect(refused).toEqual({ text: POSITIONING_REQUIRED_NOTICE, kept: true });
    expect(positioningRequiredNotice('n').text).toBe(refused.text);
  });

  it('opens the one-click start and import entries, each with its own start request', () => {
    const navigate = vi.fn();
    const { actions } = positioningRequiredNotice('n', navigate);
    const [start, existing] = actions!;
    expect([start!.label, existing!.label]).toEqual([POSITIONING_ACTIONS.mentor, POSITIONING_ACTIONS.manual]);
    start!.onClick(); existing!.onClick(); start!.onClick();
    const entries = navigate.mock.calls.map(([href]) => {
      const url = new URL(href, 'https://x');
      return { path: url.pathname, ...readStartEntry(url.search) };
    });
    expect(entries.map(e => [e.path, e.mode])).toEqual([['/app/positioning', 'mentor'], ['/app/positioning', 'manual'], ['/app/positioning', 'mentor']]);
    expect(entries.every(e => e.intent)).toBe(true);
    expect(new Set(entries.map(e => e.intent)).size).toBe(3);
  });

  it('builds the entry link from the intent', () => {
    expect(positioningEntryHref('manual', '11111111-1111-4111-8111-111111111111'))
      .toBe('/app/positioning?start=manual&intent=11111111-1111-4111-8111-111111111111');
  });
});

// 走查 26: the account already has a positioning under way. Starting another is refused once the profile allowance is used, so
// the first button goes back to the one that exists.
describe('positioning guide card for an account with a positioning under way', () => {
  const profile = (businessId: string, draftIds: string[], isArchived = false) =>
    ({ businessId, name: businessId, isArchived, archivedAt: isArchived ? '2026-11-01' : null, drafts: draftIds.map(draftId => ({ draftId })) });

  it('finds the newest profile that can still be worked on; archived ones and ones without a draft are not it', () => {
    expect(existingPositioning([profile('old', ['d-old']), profile('new', ['d-new'])], false)).toEqual({ state: 'draft', draftId: 'd-new' });
    expect(existingPositioning([profile('live', ['d-live']), profile('gone', ['d-gone'], true)], false)).toEqual({ state: 'draft', draftId: 'd-live' });
    expect(existingPositioning([profile('gone', ['d-gone'], true), profile('empty', [])], false)).toEqual({ state: 'none' });
    expect(existingPositioning([], false)).toEqual({ state: 'none' });
  });

  it('is not known while the profiles are being read, and falls back to the ordinary entries when the read fails', () => {
    expect(existingPositioning(undefined, false)).toEqual({ state: 'checking' });
    expect(existingPositioning(undefined, true)).toEqual({ state: 'none' });
    expect(existingPositioning([profile('p', ['d'])], true)).toEqual({ state: 'none' });
  });

  it('offers 继续我的定位, which opens that positioning and starts nothing, and keeps the import entry', () => {
    const navigate = vi.fn();
    const notice = positioningRequiredNotice('n', navigate, { state: 'draft', draftId: 'd-1' });
    expect(notice.text).toBe(POSITIONING_REQUIRED_NOTICE);
    expect(notice.actions!.map(action => action.label)).toEqual([POSITIONING_ACTIONS.resume, POSITIONING_ACTIONS.manual]);
    notice.actions![0]!.onClick();
    expect(navigate).toHaveBeenLastCalledWith('/app/positioning/d-1');
    const markup = renderToStaticMarkup(createElement(ChatNoticeList, { notices: [notice] }));
    expect(markup).toContain('>继续我的定位</button>');
    expect(markup).not.toContain('>开始定位</button>');
  });

  it('shows the explanation alone while it is not known, so no button changes under the pointer', () => {
    const notice = positioningRequiredNotice('n', vi.fn(), { state: 'checking' });
    const markup = renderToStaticMarkup(createElement(ChatNoticeList, { notices: [notice] }));
    expect(markup).toContain('本次没有扣积分');
    expect(markup).not.toContain('<button');
  });
});
