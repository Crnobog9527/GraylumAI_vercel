/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { tabFromSearch } from '@/components/publish-monitor/DataReviewView';

/**
 * One-click publishing sends a user without a usable account to the data review page to connect or allow one. That is
 * done on its "账号" tab, so the links name the tab; the page opens on "数据趋势" otherwise and the user has to find it.
 */
const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
const links = (source: string) => [...source.matchAll(/href="(\/app\/publish-monitor[^"/]*)"/g)].map(match => match[1]);

it('every link from one-click publishing to the data review page opens the accounts tab', () => {
  const found = [...links(read('publish-form.tsx')), ...links(read('publish-view.tsx'))];
  expect(found).toHaveLength(3);
  for (const href of found) {
    expect(href).toBe('/app/publish-monitor?tab=accounts');
    expect(tabFromSearch(new URL(href, 'https://x.test').search)).toBe('accounts');
  }
});
