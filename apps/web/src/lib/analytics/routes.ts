/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { PUBLIC_PAGES } from '@/lib/seo/public-pages';

/**
 * Which addresses analytics may report, and as what (ANALYTICS plan §3.1, O2). Every page is reported by its
 * route template, so draft, review and other record IDs never leave the browser. A page without a template
 * here is not reported at all (new pages stay out until they are added). Pages that carry a one-time key or
 * personal data in their address send nothing to any analytics service while they are open.
 * `routes.test.ts` checks that every page under src/app is listed here or as sensitive.
 */
const APP_TEMPLATES = [
  '/',
  '/app',
  '/landing',
  '/pricing',
  '/founders',
  '/landing/preview/[variant]',
  '/landing/preview/d',
  '/landing/preview/e',
  '/landing/preview/f',
  '/landing/preview/g',
  '/landing/preview/h',
  '/landing/preview/i',
  '/landing/preview/j',
  '/landing/preview/jury',
  '/landing/preview/k',
  '/landing/preview/l',
  '/landing/preview/m',
  '/landing/preview/n',
  '/landing/preview/o',
  '/features',
  '/features/[feature]',
  '/maintenance',
  '/access-denied',
  '/login',
  '/register',
  '/forgot-password',
  '/app/marketplace',
  '/app/library',
  '/app/library/scan-check',
  '/app/profile',
  '/app/expert-consult',
  '/app/runtime',
  '/app/positioning',
  '/app/positioning/[draftId]',
  '/app/positioning/[draftId]/plan',
  '/app/positioning/[draftId]/review/[reviewId]',
  '/app/positioning/[draftId]/topics',
  // Public content pages whose address carries a page name, not a record ID (the pages themselves are in PUBLIC_PAGES).
  '/features/[slug]',
  '/blog/[slug]',
  // A missing /zh-tw page answered by the Taiwan 404 (the address is never reported, only this template).
  '/zh-tw/[...missing]',
  '/app/workbench/agent-first-preview',
  '/app/workbench/marketplace',
  '/app/workbench/search',
  '/admin',
  '/admin/announcements',
  '/admin/costs',
  '/admin/diagnostics',
  '/admin/finance',
  '/admin/founders',
  '/admin/models',
  '/admin/orders',
  '/admin/packages',
  '/admin/payment-notices',
  '/admin/performance',
  '/admin/prompts',
  '/admin/refunds',
  '/admin/secrets',
  '/admin/settings',
  '/admin/skills',
  '/admin/tickets',
  '/admin/transactions',
  '/admin/users',
];

/** Address prefixes that carry a one-time key or personal data (auth callback, email verification, password
 * reset, a social-account connection return): no GA, Vercel Analytics or Speed Insights request while open. */
export const SENSITIVE_PREFIXES = ['/auth', '/verify-email', '/reset-password', '/app/publish-monitor'];

export const ROUTE_TEMPLATES: readonly string[] = [...new Set([...PUBLIC_PAGES.map(page => page.path), ...APP_TEMPLATES])];

const split = (path: string) => path.split('/').filter(Boolean);
const STATIC = ROUTE_TEMPLATES.filter(template => !template.includes('['));
const DYNAMIC = ROUTE_TEMPLATES.filter(template => template.includes('[')).map(template => split(template));

function normalize(pathname: string): string {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed || '/';
}

export function isSensitivePath(pathname: string): boolean {
  const path = normalize(pathname);
  return SENSITIVE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

/** The route template for an address path, or null when the page must not be reported. */
export function routeTemplate(pathname: string): string | null {
  const path = normalize(pathname);
  if (isSensitivePath(path)) return null;
  if (STATIC.includes(path)) return path;
  const segments = split(path);
  const match = DYNAMIC.find(template => template.length === segments.length
    && template.every((part, index) => part.startsWith('[') || part === segments[index]));
  return match ? `/${match.join('/')}` : null;
}
