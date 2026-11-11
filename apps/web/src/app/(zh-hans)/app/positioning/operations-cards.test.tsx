/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: unknown }) => <a href={href}>{children as never}</a> }));

import { OperationsCards } from './operations-cards';

/**
 * Walkthrough 2026-11-11, item 28: the rail already opened 发布排期 and 数据复盘, while the two cards of the start page
 * still said "待接入" and could not be clicked. The cards now follow the rail's switch.
 */
it('open: both cards are links to their pages and neither says "待接入"', () => {
  const html = renderToStaticMarkup(<OperationsCards open />);
  expect(html).toContain('href="/app/publish-schedule"');
  expect(html).toContain('href="/app/publish-monitor"');
  expect(html).toContain('发布排期');
  expect(html).toContain('数据复盘');
  expect(html).not.toContain('待接入');
  expect(html).not.toContain('disabled');
});

it('closed (the admin switch is off): both stay unavailable and say so, as the rail does', () => {
  const html = renderToStaticMarkup(<OperationsCards open={false} />);
  expect(html.match(/<button disabled=""/g)).toHaveLength(2);
  expect(html.match(/待接入/g)?.length).toBeGreaterThanOrEqual(2);
  expect(html).not.toContain('href=');
});

it('the start page asks the rail\'s own question (same read, same options) and has no "待接入" text of its own', () => {
  const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');
  const frame = readFileSync(fileURLToPath(new URL('../../../../components/opc/workspace-frame.tsx', import.meta.url)), 'utf8');
  const read = 'trpc.publishMonitor.features.useQuery(undefined,{staleTime:300_000,...READ_RETRY})';
  expect(page).toContain(read);
  expect(frame).toContain(read);
  expect(page).toContain('const toolsOpen=publishTools.data?.ownData===true;');
  expect(page).toContain('<OperationsCards open={toolsOpen}/>');
  expect(page).not.toContain('待接入');
});
