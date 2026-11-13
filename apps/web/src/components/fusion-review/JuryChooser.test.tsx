/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => <a {...props as object} /> }));
vi.mock('@/trpc/client', () => ({ trpc: {} }));
import { JURY_REVISING_NOTE, JuryChoiceRow, juryEntryHref } from './JuryChooser';

it('FUSION-REVIEW: a positioning under revision says why it cannot be reviewed yet and offers no way into the jury', () => {
  const html = renderToStaticMarkup(<JuryChoiceRow choice={{ draftId: 'd1', name: '小红书 · 报税笔记', business: '美国报税', revising: true }}
    onClose={() => {}} />);
  expect(html).toContain(JURY_REVISING_NOTE);
  expect(html).not.toContain(juryEntryHref('d1'));
  expect(html).toContain('href="/app/positioning/d1"');
  expect(html).toContain('继续修订');
});

it('a confirmed positioning leads to its report page with the jury card open', () => {
  const html = renderToStaticMarkup(<JuryChoiceRow choice={{ draftId: 'd1', name: '小红书 · 报税笔记', business: '美国报税' }} onClose={() => {}} />);
  expect(html).toContain(`href="${juryEntryHref('d1').replace('&', '&amp;')}"`);
  expect(html).not.toContain(JURY_REVISING_NOTE);
});
