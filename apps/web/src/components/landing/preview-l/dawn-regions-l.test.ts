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
const layer = readFileSync(join(__dirname, 'dawn-regions-l.module.css'), 'utf8');
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
const count = (needle: string) => html.split(needle).length - 1;

// LANDING-ART step two (Owner 2026-11-11, MASTER_PLAN 2.1 / #1867): the regions under the first screen in sample D's look.
describe('the home page\'s 晨光 layer, step two: the regions under the first screen', () => {
  // The layer reaches the regions by these marks, not by the other modules' class names: a mark that goes takes its look with it.
  it('finds every mark its rules are written against, on the page as it is drawn', () => {
    for (const region of ['用户心声', '三步', '第一步', '第二步', '第三步', '评审团', '样例报告', '对比区', '价格', '费用对比表', 'Graylum 价格',
      '常见问题', '结尾行动']) expect(count(`data-region="${region}"`), region).toBe(1);
    expect(count('data-region="心声卡片"')).toBeGreaterThanOrEqual(5);
    expect(count('data-region="流程模块"')).toBe(11);
    expect(count('data-region="问题分组"')).toBeGreaterThanOrEqual(2);
    for (const id of ['voice-title', 'steps-title', 'samples-title', 'compare-title', 'pricing-title', 'faq-title', 'final-title', 'j-voice-wall']) {
      expect(count(` id="${id}"`), id).toBe(1);
      expect(layer, id).toContain(`[id='${id}']`);
    }
    // A voice: what they said (figure), the arrow (svg, hidden by the layer), the coach's answer (div) whose first line is its head.
    expect(html).toMatch(/<li data-row=""[^>]*data-region="心声卡片"><figure[^>]*><blockquote>.*?<\/figure><svg[^>]*>.*?<\/svg><div[^>]*><p[^>]*><i aria-hidden="true"><\/i>/s);
    // A module's picture is the one inert child; the jury's panel, the report viewer and the comparison's tabs carry their own marks.
    expect(html).toMatch(/data-region="流程模块">.*?<div[^>]* inert=""/s);
    expect(count('data-jury-panel=""')).toBe(1);
    const samples = html.slice(html.indexOf('data-region="样例报告"'), html.indexOf('data-region="对比区"'));
    expect(samples).toMatch(/<nav [^>]*>/);
    expect(samples).toContain('aria-pressed="true"');
    expect(samples).toContain('role="region"');
    const compare = html.slice(html.indexOf('data-region="对比区"'), html.indexOf('data-region="价格"'));
    expect(compare).toContain('role="tablist"');
    expect(compare).toContain('aria-selected="true"');
    expect(compare).toContain('role="tabpanel"');
    const faq = html.slice(html.indexOf('data-region="常见问题"'), html.indexOf('data-region="结尾行动"'));
    expect(faq).toMatch(/data-region="问题分组"><h3>[^<]+<\/h3><details/);
  });

  it('writes ids as attributes: a CSS module renames an #id selector as it renames a class', () => {
    for (const id of ['voice-title', 'steps-title', 'samples-title', 'compare-title', 'pricing-title', 'faq-title', 'final-title', 'j-voice-wall']) {
      expect(layer, id).not.toContain(`#${id}`);
    }
  });

  it('sits on the home page\'s root only', () => {
    const files = [join(SRC, 'components/landing'), join(SRC, 'components/public-site')].flatMap(sources)
      .map(path => [path.slice(SRC.length + 1), readFileSync(path, 'utf8')] as const);
    const users = (needle: string) => files.filter(([, source]) => source.includes(needle)).map(([path]) => path).sort();
    expect(users('dawn-regions-l.module.css\'')).toEqual(['components/landing/preview-l/SampleL.tsx']);
    expect(users('regions.regions')).toEqual(['components/landing/preview-l/SampleL.tsx']);
    // Every rule starts from the layer's own class, so nothing here can reach another page.
    const selectors = layer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{/g, '').split('}')
      .map(rule => rule.slice(0, rule.indexOf('{')).trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(40);
    for (const selector of selectors) for (const part of selector.split(/,\s*(?![^()]*\))/)) expect(part.trim(), selector).toMatch(/^\.regions/);
  });

  it('sets a colour token only inside the two regions whose band changed (the jury goes dark, the comparison light)', () => {
    const rules = layer.replace(/\/\*[\s\S]*?\*\//g, '').split('}');
    const setting = rules.filter(rule => /--j-[\w-]+\s*:/.test(rule.slice(rule.indexOf('{'))));
    expect(setting).toHaveLength(3);
    for (const rule of setting) expect(rule.slice(0, rule.indexOf('{'))).toMatch(/data-region='(评审团|对比区)'/);
    expect(layer).not.toMatch(/--(pub|gl)-[\w-]+\s*:/);
  });

  it('adds no motion and no strike-through to the price', () => {
    const rules = layer.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/animation|transition|@keyframes/);
    expect(rules).not.toContain('line-through');
  });
});
