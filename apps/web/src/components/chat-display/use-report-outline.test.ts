/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { findReportChapters } from './use-report-outline';

// Just enough of the DOM for the heading scan: [tag, text, inside a closed details box].
const root = (...items: [string, string, boolean?][]) => ({
  querySelectorAll: () => items.map(([tagName, textContent, closed]) => ({ tagName, textContent, closest: () => (closed ? {} : null) })),
}) as unknown as HTMLElement;
const titles = (found: HTMLElement[]) => found.map(heading => heading.textContent);

it('takes the shallowest heading level used at least twice, so one title above ## chapters is not the only chapter', () => {
  expect(titles(findReportChapters(root(['H1', '报告'], ['H2', '甲'], ['H2', '乙'], ['H3', '细'])))).toEqual(['甲', '乙']);
});
it('ignores headings in a closed details box and empty headings', () => {
  expect(titles(findReportChapters(root(['H2', '甲'], ['H2', ' '], ['H2', '旧', true], ['H2', '乙'])))).toEqual(['甲', '乙']);
});
it('finds nothing in a report without repeated headings', () => {
  expect(findReportChapters(root(['H2', '唯一']))).toEqual([]);
});
