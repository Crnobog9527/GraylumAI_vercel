import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test.describe('Login Page', () => {
    test('should display login form', async ({ page }) => {
      await page.goto('/login');

      // Check for email input
      await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible();

      // Check for password input
      await expect(page.locator('input[type="password"], input[name="password"]')).toBeVisible();

      // Check for submit button
      await expect(page.locator('button[type="submit"]')).toBeVisible();
    });

    test('should show error for invalid credentials', async ({ page }) => {
      await page.goto('/login');

      // Enter invalid credentials
      await page.fill('input[type="email"], input[name="email"]', 'invalid@example.com');
      await page.fill('input[type="password"], input[name="password"]', 'wrongpassword');

      // Submit form
      await page.click('button[type="submit"]');

      // Should show error message
      await expect(
        page.locator('[role="alert"], .error-message, [class*="error"]').first()
      ).toBeVisible({ timeout: 5000 });
    });

    test('should show validation error for empty fields', async ({ page }) => {
      await page.goto('/login');

      // Try to submit without filling form
      await page.click('button[type="submit"]');

      // Should show validation errors or be prevented
      const emailInput = page.locator('input[type="email"], input[name="email"]');
      await expect(emailInput).toBeFocused();
    });
  });

  test.describe('Registration Page', () => {
    test('should display registration form', async ({ page }) => {
      await page.goto('/register');

      // Check for email input
      await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible();

      // Check for password input
      await expect(page.locator('input[type="password"], input[name="password"]').first()).toBeVisible();

      // Check for submit button
      await expect(page.locator('button[type="submit"]')).toBeVisible();
    });
  });

  test.describe('Authenticated User', () => {
    // Use saved auth state
    test.use({ storageState: 'tests/.auth/user.json' });

    test.skip('should show user menu when logged in', async ({ page }) => {
      await page.goto('/');

      // Should see user menu or avatar
      await expect(
        page.locator('[data-testid="user-menu"], .user-avatar, [class*="avatar"]').first()
      ).toBeVisible();
    });

    test.skip('should be able to logout', async ({ page }) => {
      await page.goto('/');

      // Click user menu
      await page.click('[data-testid="user-menu"], .user-avatar, [class*="avatar"]');

      // Click logout
      await page.click('text=登出, text=Logout, text=退出');

      // Should redirect to login
      await page.waitForURL(/\/login/);
    });
  });
});
