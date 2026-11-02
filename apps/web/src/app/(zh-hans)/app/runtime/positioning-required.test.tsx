/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import { readStartEntry } from '@/app/(zh-hans)/app/positioning/start-entry';
import { POSITIONING_REQUIRED_NOTICE } from './gate-notices';
import { POSITIONING_ACTIONS, POSITIONING_CARD_LABEL, positioningEntryHref, positioningRequiredNotice } from './positioning-required';
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
