/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { test, expect } from '@playwright/test';
import { authStatePaths, clearBrowserAuthState, getCredentials, hasCredentials } from './support/auth';
import { gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

test.describe('Authentication', () => {
  test.describe('Login Page', () => {
    test('should display login form', async ({ page }) => {
      await gotoWithBypass(page, '/login');
      await expect(page.locator('#email, input[type="email"], input[name="email"]')).toBeVisible();
      await expect(page.locator('#password, input[type="password"], input[name="password"]')).toBeVisible();
      await expect(page.locator('form').getByRole('button', { name: /^登录$|^Login$/i })).toBeVisible();
    });

    test('should show error for invalid credentials', async ({ page }) => {
      await gotoWithBypass(page, '/login');
      await page.fill(
        '#email, input[type="email"], input[name="email"]',
        `invalid-${Date.now()}@example.com`,
      );
      await page.fill('#password, input[type="password"], input[name="password"]', 'wrongpassword');
      await page.locator('form').getByRole('button', { name: /^登录$|^Login$/i }).click();

      await expect(page).toHaveURL(/\/(login|verify-email)/, { timeout: 10000 });

      const cookies = await page.context().cookies();
      const supabaseAuthCookie = cookies.find((cookie) => /sb-.*-auth-token/.test(cookie.name));
      expect(supabaseAuthCookie).toBeFalsy();
    });

    test('should expose a signup CTA that targets the app login flow', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      let actual = 'Landing CTA points to the app signup login flow';

      try {
        steps.push('Open public landing page');
        await gotoWithBypass(page, '/landing?domain=www');

        steps.push('Inspect the public signup CTA target');
        const signupLink = page.getByRole('link', { name: '免费开始' }).first();
        await expect(signupLink).toBeVisible({ timeout: 10000 });

        const href = await signupLink.getAttribute('href');
        expect(href).toBeTruthy();
        expect(href).toContain('/login?action=signup');

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown signup CTA target failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'landing-signup-cta-target',
            role: 'public',
            route: '/landing?domain=www',
            expected: 'The public signup CTA targets the app login flow with action=signup so signup intent is preserved.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });

    test('should preserve selected plan context on the signup login flow', async ({ page }) => {
      await gotoWithBypass(page, '/login?action=signup&plan=黄金会员');
      await expect(page.getByRole('button', { name: '注册', exact: true })).toBeVisible();
      await expect(page.getByText('当前来自 黄金会员 套餐入口')).toBeVisible({ timeout: 10000 });
    });
  });

  test('should preserve protected-route redirect through login', async ({ page }, testInfo) => {
    test.skip(!hasCredentials('user'), 'E2E_TEST_EMAIL and E2E_TEST_PASSWORD are required for redirect return flow');
    test.setTimeout(90000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Protected route redirect returned user after login';

    try {
      steps.push('Open a protected route with query parameters while unauthenticated');
      await gotoWithBypass(page, '/login');
      await clearBrowserAuthState(page);
      await gotoWithBypass(page, '/profile?tab=security');

      steps.push('Verify login redirect preserves the original destination');
      await expect(page).toHaveURL(/\/login\?redirect=%2Fprofile%3Ftab%3Dsecurity/);
      await expect(page.getByText('/profile?tab=security')).toBeVisible({ timeout: 10000 });

      steps.push('Authenticate with the normal E2E user');
      await page.fill('#email, input[type="email"], input[name="email"]', getCredentials('user').email);
      await page.fill('#password, input[type="password"], input[name="password"]', getCredentials('user').password);
      await page.locator('form').getByRole('button', { name: /^登录$|^Login$/i }).click();

      steps.push('Verify the browser returns to the original protected tab');
      await expect(page).toHaveURL(/\/profile\?tab=security/, { timeout: 15000 });
      await expect(page.locator('h3').filter({ hasText: '账户安全' })).toBeVisible({ timeout: 30000 });

      monitor.removeIssues((issue) =>
        issue.source === 'requestfailed' &&
        issue.message === 'net::ERR_ABORTED' &&
        issue.resourceType === 'document' &&
        (issue.url?.includes('/login?redirect=%2Fprofile%3Ftab%3Dsecurity') ?? false)
      );

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown protected redirect return failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'login-redirect-return',
          role: 'public',
          route: '/profile?tab=security',
          expected: 'Unauthenticated users keep the original protected destination through /login and land back on that route after successful authentication.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should display landing page in www mode', async ({ page }, testInfo) => {
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Landing page rendered';

    try {
      steps.push('Open /landing?domain=www');
      await gotoWithBypass(page, '/landing?domain=www');

      steps.push('Verify restored landing CTA copy and independent page links are visible');
      await expect(page.getByText('登录').first()).toBeVisible();
      await expect(page.getByText('免费开始').first()).toBeVisible();
      await expect(page.getByRole('link', { name: '使用教程' }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: '常见问题' }).first()).toBeVisible();

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown landing failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'public-landing-smoke',
          role: 'public',
          route: '/landing?domain=www',
          expected: 'Public landing page keeps the restored homepage CTA copy and still exposes the independent tutorial/FAQ links without blocking console or network issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should render public support and legal pages', async ({ page }, testInfo) => {
    test.setTimeout(90000);
    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Public support pages rendered';

    const routeExpectations = [
      { route: '/contact', heading: '需要进一步沟通时，直接找到正确入口' },
      { route: '/tutorials', heading: '先按场景上手，而不是从空白对话框开始' },
      { route: '/faq', heading: '在开始之前，先把关键问题说清楚' },
      { route: '/terms', heading: /使用 .* 前，请先了解基础服务规则/ },
      { route: '/privacy', heading: /了解 .* 如何处理账户与使用数据/ },
      { route: '/acceptable-use', heading: /明确 .* 的允许使用方式与限制/ },
    ] as const;

    try {
      for (const expectation of routeExpectations) {
        steps.push(`Open ${expectation.route}`);
        await gotoWithBypass(page, expectation.route);
        await expect(page).toHaveURL(new RegExp(expectation.route.replace('/', '\\/')));
        await expect(page.getByRole('heading', { name: expectation.heading })).toBeVisible();
      }

      monitor.removeIssues((issue) =>
        issue.source === 'requestfailed' &&
        issue.message === 'net::ERR_ABORTED' &&
        issue.resourceType === 'document' &&
        routeExpectations.some((expectation) => issue.url?.includes(expectation.route))
      );

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown public support page failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'public-support-pages-smoke',
          role: 'public',
          route: '/contact',
          expected: 'Public support, FAQ, tutorial, and legal pages render without blocking runtime issues.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test.describe('Authenticated User', () => {
    test.use({ storageState: authStatePaths.user });
    test.skip(!hasCredentials('user'), 'E2E_TEST_EMAIL and E2E_TEST_PASSWORD are required for authenticated user flows');

    test('should load home page when logged in', async ({ page }, testInfo) => {
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      let actual = 'Authenticated home page rendered';

      try {
        steps.push('Open authenticated home page');
        await gotoWithBypass(page, '/');
        await expect(page).toHaveURL(/\/$/);

        steps.push('Verify authenticated navigation is visible');
        await expect(page.getByText('个人中心').first()).toBeVisible();

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown authenticated home failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'authenticated-home-smoke',
            role: 'user',
            route: '/',
            expected: 'Authenticated users can load the home page without redirect loops or blocking runtime issues.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });

    test('should load profile page when logged in', async ({ page }, testInfo) => {
      test.setTimeout(90000);
      const steps: string[] = [];
      const monitor = createIssueMonitor(page);
      let actual = 'Profile page rendered';

      try {
        steps.push('Open /profile and verify the default profile content renders');
        await gotoWithBypass(page, '/profile');
        await expect(page).toHaveURL(/\/profile/);
        await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible({ timeout: 30000 });
        await expect(page.getByRole('button', { name: '账户安全' })).toBeVisible({ timeout: 30000 });

        steps.push('Open the subscription tab route and verify yearly pricing copy and highlight tone');
        await gotoWithBypass(page, '/profile?tab=subscription');
        await expect(page).toHaveURL(/\/profile\?tab=subscription/, { timeout: 15000 });
        const yearlyCycleButton = page.getByRole('button', { name: /按年|年付/ });
        await expect(yearlyCycleButton).toBeVisible({ timeout: 30000 });
        await yearlyCycleButton.click();
        await expect(page.getByText('年付共', { exact: false })).toHaveCount(0);

        const warmHighlightCard = page.locator('[data-highlight-tone="warm"]').first();
        if (await warmHighlightCard.isVisible().catch(() => false)) {
          await expect(warmHighlightCard).toBeVisible({ timeout: 10000 });
        }

        const blockingIssues = monitor.getIssues('P1');
        expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      } catch (error) {
        actual = error instanceof Error ? error.message : 'Unknown profile failure';
        monitor.addAssertionIssue(actual, 'P1');
        throw error;
      } finally {
        await writeFlowAudit(
          testInfo,
          {
            title: 'profile-page-smoke',
            role: 'user',
            route: '/profile',
            expected: 'Authenticated users can load profile tabs without blocking page or data-loading errors.',
          },
          actual,
          steps,
          monitor.getIssues(),
        );
      }
    });
  });
});
