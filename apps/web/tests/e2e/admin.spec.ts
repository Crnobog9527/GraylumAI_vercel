import { test, expect } from '@playwright/test';

test.describe('Admin Dashboard', () => {
  // Use authenticated state (admin user required)
  test.use({ storageState: 'tests/.auth/user.json' });

  test.describe('Admin Access', () => {
    test.skip('should redirect non-admin users', async ({ page }) => {
      // This test assumes the auth user is not an admin
      await page.goto('/admin');

      // Should be redirected or see access denied
      await expect(page).toHaveURL(/\/(login|403|home)?/);
    });
  });

  test.describe('Diagnostics Page', () => {
    test.skip('should display diagnostics dashboard', async ({ page }) => {
      await page.goto('/admin/diagnostics');

      // Check for page title or heading
      await expect(
        page.locator('h1:has-text("诊断"), h1:has-text("Diagnostics")').first()
      ).toBeVisible();
    });

    test.skip('should run diagnostics tests', async ({ page }) => {
      await page.goto('/admin/diagnostics');

      // Find and click run tests button
      const runButton = page.locator('button:has-text("运行"), button:has-text("Run")').first();
      await runButton.click();

      // Wait for results
      await expect(
        page.locator('[class*="result"], [class*="test-result"]').first()
      ).toBeVisible({ timeout: 30000 });
    });

    test.skip('should display test results', async ({ page }) => {
      await page.goto('/admin/diagnostics');

      // Run tests first
      await page.click('button:has-text("运行"), button:has-text("Run")');

      // Wait for completion
      await page.waitForTimeout(5000);

      // Should show pass/fail indicators
      await expect(
        page.locator(':text("通过"), :text("Pass"), :text("✓"), :text("✅")').first()
      ).toBeVisible();
    });
  });

  test.describe('Cost Monitoring Page', () => {
    test.skip('should display costs dashboard', async ({ page }) => {
      await page.goto('/admin/costs');

      // Check for page title
      await expect(
        page.locator('h1:has-text("成本"), h1:has-text("Cost")').first()
      ).toBeVisible();
    });

    test.skip('should display tabs', async ({ page }) => {
      await page.goto('/admin/costs');

      // Check for tab navigation
      await expect(page.locator('[role="tablist"], [class*="tabs"]')).toBeVisible();
    });

    test.skip('should switch between tabs', async ({ page }) => {
      await page.goto('/admin/costs');

      // Find tabs
      const tabs = page.locator('[role="tab"], button[class*="tab"]');

      const count = await tabs.count();
      if (count > 1) {
        // Click second tab
        await tabs.nth(1).click();

        // Content should change
        await page.waitForTimeout(500);
      }
    });
  });

  test.describe('User Management', () => {
    test.skip('should display users list', async ({ page }) => {
      await page.goto('/admin/users');

      // Should show user table or list
      await expect(
        page.locator('table, [class*="user-list"], [data-testid="users-table"]').first()
      ).toBeVisible();
    });

    test.skip('should be able to search users', async ({ page }) => {
      await page.goto('/admin/users');

      // Find search input
      const searchInput = page.locator('input[type="search"], input[placeholder*="搜索"], input[placeholder*="Search"]');

      if (await searchInput.isVisible()) {
        await searchInput.fill('test');
        await page.waitForTimeout(500);

        // Results should update
        await expect(page.locator('table tbody tr, [class*="user-item"]').first()).toBeVisible();
      }
    });
  });
});
