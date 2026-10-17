import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSensitivePath, routeTemplate, ROUTE_TEMPLATES, SENSITIVE_PREFIXES } from './routes';

const APP_DIR = path.resolve(__dirname, '../../app');

function pageRoutes(dir: string, segments: string[] = []): string[] {
  const routes: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'api' || name.startsWith('_')) continue;
      // Route groups `(name)` do not appear in the address.
      routes.push(...pageRoutes(full, /^\(.*\)$/.test(name) ? segments : [...segments, name]));
    } else if (name === 'page.tsx') {
      routes.push(`/${segments.join('/')}`);
    }
  }
  return routes;
}

describe('route templates', () => {
  it('covers every page under src/app as a template or a sensitive page', () => {
    for (const route of pageRoutes(APP_DIR)) {
      const covered = ROUTE_TEMPLATES.includes(route) || SENSITIVE_PREFIXES.some(prefix => route === prefix || route.startsWith(`${prefix}/`));
      expect(covered, `${route} needs an analytics route template (or a sensitive prefix)`).toBe(true);
    }
  });

  it('reports record pages by their template, never the ID', () => {
    expect(routeTemplate('/positioning/3f2a9c1e-0000-4000-8000-000000000001')).toBe('/positioning/[draftId]');
    expect(routeTemplate('/positioning/abc/review/def')).toBe('/positioning/[draftId]/review/[reviewId]');
    expect(routeTemplate('/positioning/abc/topics/')).toBe('/positioning/[draftId]/topics');
    expect(routeTemplate('/landing/preview/d')).toBe('/landing/preview/d');
    expect(routeTemplate('/landing/preview/zz')).toBe('/landing/preview/[variant]');
    expect(routeTemplate('/zh-tw/ig-jingying')).toBe('/zh-tw/ig-jingying');
    expect(routeTemplate('/')).toBe('/');
  });

  it('drops unknown and sensitive pages', () => {
    expect(routeTemplate('/positioning/a/b/c/d')).toBeNull();
    expect(routeTemplate('/someone@example.com')).toBeNull();
    for (const path of ['/auth/callback', '/verify-email', '/reset-password', '/publish-monitor/connect', '/auth']) {
      expect(isSensitivePath(path)).toBe(true);
      expect(routeTemplate(path)).toBeNull();
    }
    expect(isSensitivePath('/authority')).toBe(false);
  });
});
