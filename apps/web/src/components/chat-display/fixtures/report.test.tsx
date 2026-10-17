/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { ReportOutline, ReportWithOutline } from '../report-outline';
import * as R from './report';

// The landing page renders the shared fixtures exactly like this: they must stay renderable.
it('renders the report chapter list from the shared fixtures', () => {
  const html = renderToStaticMarkup(<ReportOutline chapters={R.SAMPLE_REPORT_CHAPTERS} activeId={R.SAMPLE_REPORT_ACTIVE_CHAPTER} onSelect={() => {}}/>);
  for (const title of R.SAMPLE_REPORT_CHAPTER_TITLES) expect(html).toContain(title);
  expect(html).toContain('aria-label="报告目录"');
  expect(html.match(/aria-current="location"/g)).toHaveLength(1);
});

it('has the 13 chapters plus the one-line conclusion, each with a heading in the sample body', () => {
  expect(R.SAMPLE_REPORT_CHAPTERS).toHaveLength(14);
  const html = renderToStaticMarkup(<MessageMarkdown text={R.SAMPLE_REPORT_BODY}/>);
  expect(html.match(/<h2>/g)).toHaveLength(14);
});

it('leaves out the list when the report has too few chapters', () => {
  const few = renderToStaticMarkup(<ReportWithOutline chapters={R.SAMPLE_REPORT_CHAPTERS.slice(0, 1)} activeId={null} onSelect={() => {}}><p>正文</p></ReportWithOutline>);
  expect(few).toContain('正文');
  expect(few).not.toContain('报告目录');
  const many = renderToStaticMarkup(<ReportWithOutline chapters={R.SAMPLE_REPORT_CHAPTERS} activeId={null} onSelect={() => {}}><p>正文</p></ReportWithOutline>);
  expect(many).toContain('报告目录');
});
