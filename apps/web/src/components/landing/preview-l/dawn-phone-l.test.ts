/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { trpc } from '@/trpc/client';
import { SampleL } from './SampleL';

const SRC = join(__dirname, '../../..');
const layer = readFileSync(join(__dirname, 'dawn-phone-l.module.css'), 'utf8');
const rules = layer.replace(/\/\*[\s\S]*?\*\//g, '').trim();
const sources = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sources(path);
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
});

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
// The page sits inside the app's tRPC provider (as sample-l.test.ts sets it up); nothing is fetched.
const queryClient = new QueryClient();
const client = trpc.createClient({ links: [httpLink({ url: 'http://landing.test/api/trpc' })] });
const withTrpc = (node: ReactElement) =>
  createElement(trpc.Provider, { client, queryClient, children: createElement(QueryClientProvider, { client: queryClient }, node) });
const html = renderToStaticMarkup(withTrpc(createElement(SampleL, { data, siteName: 'Graylum', extras: { flags: ALL_ON, showSamples: true } })));
const between = (from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to));

// Owner 2026-11-12: the phone is laid out the way an app is, phone plan A. Step one: the public home page.
describe('the home page on a phone, laid out the way an app is', () => {
  it('changes nothing above 640px: the whole layer is one block for narrower screens', () => {
    expect(rules.startsWith('@media (max-width: 639px) {')).toBe(true);
    // One block and nothing after it: its closing brace is the file's last character, and no other at-rule opens.
    expect(rules.match(/@media/g)).toHaveLength(1);
    expect(rules.endsWith('}')).toBe(true);
    let depth = 0;
    let closedAt = -1;
    [...rules].forEach((char, index) => {
      if (char === '{') depth += 1;
      if (char === '}') { depth -= 1; if (depth === 0 && closedAt < 0) closedAt = index; }
    });
    expect(closedAt).toBe(rules.length - 1);
  });

  it('only lays the page out again: no colour token, no motion, and every rule starts from the home page\'s root', () => {
    expect(rules).not.toMatch(/--j-[a-z-]+\s*:|--pub-[a-z-]+\s*:/);
    expect(rules).not.toMatch(/animation|transition|@keyframes/);
    const selectors = [...rules.slice(rules.indexOf('{') + 1).matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(rule => rule[1].replace(/\([^)]*\)/g, '()').split(',')).map(selector => selector.trim());
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) expect(selector, selector).toMatch(/^\.phone\.phone /);
  });

  it('sits on the home page\'s root only', () => {
    const files = [join(SRC, 'components/landing'), join(SRC, 'components/public-site')].flatMap(sources)
      .map(path => [path.slice(SRC.length + 1), readFileSync(path, 'utf8')] as const);
    const users = files.filter(([, source]) => source.includes('dawn-phone-l.module.css\'')).map(([path]) => path);
    expect(users).toEqual(['components/landing/preview-l/SampleL.tsx']);
    expect(html).toMatch(/^(?:<link[^>]*>)*<div class="[^"]*phone[^"]*"/);
  });

  // The layer reaches the page by these marks: a mark that goes takes the phone layout with it.
  it('finds every mark its rules are written against, on the page as it is drawn', () => {
    // The menu: the header's drawer is its direct child with an id, hidden until opened; its places are links in groups.
    const header = between('<header', '</header>');
    expect(header).toMatch(/<div id="[^"]+" class="[^"]*drawer[^"]*" hidden=""><nav [^>]*>(?:<div[^>]*>(?:<p>[^<]*<\/p>)?(?:<a [^>]*>[^<]*<\/a>)+<\/div>)+/);
    // Staging review of #1932: the menu was sized as the screen less 64px while the bar stood 52px tall, and the page showed
    // under it. No number is written now: the open header is as tall as the screen and the menu takes what the bar leaves.
    expect(rules).toContain('.phone.phone header:has(> [id]:not([hidden]) > nav) { display: flex; flex-direction: column; height: 100dvh; padding-bottom: 0; }');
    expect(rules).toMatch(/\.phone\.phone header > \[id\]:not\(\[hidden\]\) \{ flex: 1 1 0; min-height: 0; max-height: none;/);
    expect(rules).not.toMatch(/100dvh - \d+px/);
    // The header that holds the menu is the only header with a direct child that has an id and holds a nav.
    const headers = html.split('<header').slice(1).map(part => part.slice(0, part.indexOf('</header>')));
    expect(headers.filter(part => /<div id="[^"]+"[^>]*><nav /.test(part))).toHaveLength(1);
    // The voices: one list, each voice a row.
    expect(html).toMatch(/<ol id="j-voice-wall"[^>]*><li data-row=""/);
    expect(layer).toContain('[id=\'j-voice-wall\']');
    expect(layer).not.toContain('#j-voice-wall');
    // Each of the three steps keeps its modules in one counted list, inside the three-steps region.
    const steps = between('data-region="三步"', 'data-region="样例报告"');
    expect(steps.match(/<ol [^>]*data-count="\d"/g)).toHaveLength(3);
    expect(steps.match(/<ol [^>]*data-count="\d"[^>]*><li [^>]*data-region="流程模块"/g)).toHaveLength(3);
    // The sample report: the viewer is the region, and its last child holds the button that opens the whole report.
    const samples = between('data-region="样例报告"', 'data-region="对比区"');
    expect(samples).toMatch(/role="region"/);
    expect(samples).toMatch(/<div class="[^"]*actions[^"]*"><button [^>]*>(?:<svg.*?<\/svg>)?查看完整报告<\/button><dialog/s);
    // …and that holder is the viewer's last child: the viewer, the browser, the wrap and the section close right after it.
    expect(samples).toMatch(/<\/a><\/div><\/div><\/div><\/div><\/section><section [^>]*$/);
  });
});
