/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * UI-UNIFY A (paywall dialogs): every paywall entry is the light signed-in dialog (DESIGN.md "Dialog": white, 18px radius, the dialog
 * shadow, a light backdrop) wherever it is opened, and works on a phone. The real components with globals.css and Tailwind in Chrome, on a
 * page with the dark root values (no light workbench around them), at 390 and 360px: no dark surface is left, nothing scrolls sideways,
 * the controls are 44px touch targets, captions reach 4.5:1, and the last control can be scrolled into view.
 * PAYWALL_LIGHT_SHOTS=<dir> saves a screenshot of each case.
 */
let browser: Browser;
let code = '';
let css = '';
const entry = fileURLToPath(new URL('./__paywall_light_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../', import.meta.url));
const shots = process.env.PAYWALL_LIGHT_SHOTS;

const trpcMock = `
  const q = value => ({ data: value, isLoading: false, isError: false, isSuccess: true });
  const plan = (level, monthly, yearly) => ({ id: level + '-plan', name: level, level, price: { monthly, yearly },
    credits: { monthly: level === 'pro' ? 3480 : 8970, monthlyBonus: 0 }, discount: level === 'pro' ? 0.05 : 0.1,
    checkoutReady: { monthly: true, yearly: true } });
  const routes = { version: 7, card: { enabled: true }, card_cn: { enabled: true }, wechat_pay: { enabled: true, annualVerified: true },
    alipay: { enabled: true, annualVerified: true } };
  export const trpc = {
    publishMonitor: { features: { useQuery: () => q({ publish: true, ownData: true, weeklyReview: true }) } },
    user: { getEntitlements: { useQuery: () => q({ level: window.__level ?? 'free' }) } },
    settings: { getMembershipPlans: { useQuery: () => q([plan('free', 0, 0), plan('pro', 29, 279), plan('gold', 69, 621)]) } },
    payments: {
      getMembershipEligibilityMatrix: { useQuery: () => q({ entries: [] }) },
      methodMembership: { useQuery: () => q({ mode: 'test', routes, checkoutReady: true, termsVersion: 'terms-v3', goldFirstMonthEligible: false,
        checkoutMethods: ['card', 'card_cn', 'wechat_pay', 'alipay'], founder: { total: 50, sold: 37, reserved: 0, available: 13 }, memberships: [] }) },
      methodCheckout: { useMutation: () => ({ isPending: false, mutateAsync: async () => ({ orderId: 'o1', state: 'open', url: null }) }) },
    },
  };
`;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const styles = fileURLToPath(new URL('../../app/globals.css', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } }, css: { postcss: { plugins: [tailwind({ base: src })] } },
    resolve: { alias: { '@': src } },
    plugins: [{ name: 'paywall-light-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0paywall-light-trpc';
    }, load(id: string) {
      if (id === '\0paywall-light-trpc') return trpcMock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import ${JSON.stringify(styles)};
        import { ReportPaywallDialog } from ${JSON.stringify(src + 'components/paywall/ReportPaywallDialog.tsx')};
        import { MethodCheckoutDialog } from ${JSON.stringify(src + 'components/paywall/MethodCheckoutDialog.tsx')};
        import { useMethodCheckout } from ${JSON.stringify(src + 'components/paywall/useMethodCheckout.ts')};
        const target = { title: '开通 Pro 会员', description: '每月 3,480 积分，可随时取消。', price: '$29 / 月', renewal: '每月自动续费 $29。',
          cta: '确认并支付 $29', details: ['每月 3,480 积分', '积分包 95 折'],
          purchase: { itemType: 'membership_plan', itemId: 'pro-plan', billingCycle: 'monthly', offer: 'standard' } };
        function Checkout() { return React.createElement(MethodCheckoutDialog, { target, checkout: useMethodCheckout(), onClose() {} }); }
        const views = {
          report: () => React.createElement(ReportPaywallDialog, { onClose() {} }),
          coach: () => React.createElement(ReportPaywallDialog, { scene: 'coach', minLevel: 'pro', onClose() {} }),
          jury: () => React.createElement(ReportPaywallDialog, { scene: 'jury', onClose() {} }),
          'compare-pro': () => React.createElement(ReportPaywallDialog, { scene: 'compare', onClose() {} }),
          checkout: () => React.createElement(Checkout),
        };
        createRoot(document.getElementById('root')).render(React.createElement(views[window.__view]));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'PaywallLightTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] =
    Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find(item => item.type === 'chunk')?.code ?? '';
  css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(view: string, width: number, level = 'free'): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 760 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  // The dark root values (globals.css :root), as on a page outside the light workbench.
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>`
    + '</head><body><div id="root"></div></body></html>');
  await page.evaluate(([name, member]) => Object.assign(window, { __view: name, __level: member }), [view, level]);
  await page.addScriptTag({ content: code });
  return { page, errors };
}

type Measured = {
  background: string; radius: string; overflow: number; inner: number; dark: string[]; small: string[]; faint: string[];
  closeWidth: number; lastBottom: number; viewport: number;
};

/** What the dialog looks like: its panel, any dark surface or faint text inside it, sideways overflow, and undersized targets. */
const measure = (page: Page, selector: string) => page.evaluate((target): Measured => {
  const dialog = document.querySelector(target) as HTMLElement;
  const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
  const lum = ([r, g, b]: number[]) => [r, g, b].map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const name = (element: Element) => `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 24)}"`;
  const all = [dialog, ...dialog.querySelectorAll('*')] as HTMLElement[];
  const dark = all.filter(element => {
    const [r, g, b, a = 1] = rgb(getComputedStyle(element).backgroundColor);
    // The one dark primary action per area (DESIGN.md "Button") is meant to be dark.
    return a > 0.1 && lum([r, g, b]) < 0.5 && !element.closest('button, a');
  }).map(name);
  // Each piece of text against the surface it sits on (the white panel, the #f7f7f7 aside, a dark button); disabled controls are exempt.
  const surface = (element: Element | null): number[] => {
    for (let node = element; node; node = node.parentElement) {
      const [r, g, b, a = 1] = rgb(getComputedStyle(node).backgroundColor);
      if (a > 0.1) return [r, g, b];
    }
    return [255, 255, 255];
  };
  const ratio = (one: number, two: number) => (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
  const faint = all.filter(element => [...element.childNodes].some(node => node.nodeType === 3 && node.textContent!.trim())
    && !element.closest('button:disabled, label:has(input:disabled)'))
    .filter(element => ratio(lum(rgb(getComputedStyle(element).color)), lum(surface(element))) < 4.5)
    .map(element => `${name(element)} ${getComputedStyle(element).color} on ${surface(element)}`);
  const visible = (element: Element) => (element as HTMLElement).getClientRects().length > 0;
  const targets = [...dialog.querySelectorAll('button, label:has(input), a[href*="tab=subscription"], [data-testid$="support-ticket"]')]
    .filter(visible);
  const small = targets.filter(element => element.getBoundingClientRect().height < 44).map(name);
  const close = [...dialog.querySelectorAll('button')].find(button => /关闭|Close/.test(button.getAttribute('aria-label') ?? button.textContent ?? ''));
  dialog.scrollTop = dialog.scrollHeight;
  const last = targets.at(-1)?.getBoundingClientRect();
  const style = getComputedStyle(dialog);
  return { background: style.backgroundColor, radius: style.borderTopLeftRadius, overflow: document.documentElement.scrollWidth - innerWidth,
    inner: dialog.scrollWidth - dialog.clientWidth, dark, small, faint, closeWidth: close?.getBoundingClientRect().width ?? 0,
    lastBottom: last?.bottom ?? Infinity, viewport: innerHeight };
}, selector);

const CASES: Array<[string, string, string, string]> = [
  ['report', 'free', '[data-testid="report-paywall"]', '你的运营策略报告，只差最后一步'],
  ['coach', 'free', '[data-testid="report-paywall"]', 'Pro'],
  ['jury', 'free', '[data-testid="report-paywall"]', 'Gold'],
  ['compare-pro', 'pro', '[data-testid="report-paywall"]', '去订阅页升级到 Gold'],
  ['checkout', 'free', '[data-testid="method-checkout-dialog"]', '开通 Pro 会员'],
];

describe('paywall dialogs are the light signed-in dialog on a phone', () => {
  for (const width of [390, 360]) for (const [view, level, selector, text] of CASES) {
    it(`${view} at ${width}px: white 18px panel, no dark leftover or faint caption, no sideways scroll, 44px targets`, async () => {
      const { page, errors } = await open(view, width, level);
      try {
        await browserExpect(page.locator(selector)).toContainText(text);
        if (shots) await page.screenshot({ path: `${shots}/${view}-${width}.png` });
        const measured = await measure(page, selector);
        expect(measured.background).toBe('rgb(255, 255, 255)');
        expect(measured.radius).toBe('18px');
        expect(measured.dark, 'dark surfaces inside the dialog').toEqual([]);
        expect(measured.faint, 'text under 4.5:1 on its surface').toEqual([]);
        expect(measured.overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
        expect(measured.inner, 'the dialog scrolls sideways').toBeLessThanOrEqual(0);
        expect(measured.small, 'touch targets under 44px').toEqual([]);
        expect(measured.closeWidth).toBeGreaterThanOrEqual(44);
        expect(measured.lastBottom, 'the last control scrolls into view').toBeLessThanOrEqual(measured.viewport);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);
  }

  it('the backdrop is the light one and the desktop dialog keeps its 36px controls', async () => {
    const { page, errors } = await open('report', 1280);
    try {
      await browserExpect(page.getByTestId('report-paywall')).toBeVisible();
      const backdrop = await page.getByTestId('report-paywall').evaluate(element => getComputedStyle(element.parentElement!).backgroundColor);
      expect(backdrop).toMatch(/^(rgba\(0, 0, 0, 0\.4\)|oklab\(0 0 0 \/ 0\.4\))$/);
      const later = await page.getByRole('button', { name: '先不开通' }).boundingBox();
      expect(later?.height).toBe(36);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});
