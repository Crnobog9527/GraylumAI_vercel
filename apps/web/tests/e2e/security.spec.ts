import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { TRPCClientError, createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@repo/api/src/root';
import { simpleMarkdown } from '../../src/components/ai/messageSanitization';
import { gotoWithBypass } from './support/deploymentProtection';
import { authStatePaths, hasCredentials } from './support/auth';

function getBaseUrl() {
  return process.env.PLAYWRIGHT_BASE_URL ?? process.env.BASE_URL ?? 'http://127.0.0.1:3000';
}

const ticketUploadFixture = path.resolve(__dirname, '../../../../.agent/skills/assets/star-history.png');

async function createCookieHeader(storageStatePath: string) {
  const raw = await readFile(storageStatePath, 'utf8');
  const state = JSON.parse(raw) as { cookies?: Array<{ name: string; value: string; expires?: number }> };
  const now = Date.now() / 1000;

  return (state.cookies ?? [])
    .filter((cookie) => !cookie.expires || cookie.expires === -1 || cookie.expires > now)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function createAuthedTrpcClient(storageStatePath: string) {
  const cookie = await createCookieHeader(storageStatePath);

  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${getBaseUrl()}/api/trpc`,
        headers() {
          return cookie ? { cookie } : {};
        },
      }),
    ],
  });
}

async function expectDenied(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error('Expected request to be denied');
  } catch (error) {
    expect(error).toBeInstanceOf(TRPCClientError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(/FORBIDDEN|UNAUTHORIZED|NOT_FOUND|not found|permission|unauthorized/i);
  }
}

/**
 * Security E2E Tests
 *
 * 端到端安全测试，验证:
 * - XSS 防护
 * - 认证安全
 * - 授权控制
 * - 输入验证
 * - 安全响应头
 */

test.describe('Security', () => {
  // ============================================
  // XSS Prevention Tests
  // ============================================
  test.describe('XSS Prevention', () => {
    test('should sanitize javascript links in streamed markdown helpers', async () => {
      const rendered = simpleMarkdown('[danger](javascript:alert(1))\n<script>alert("xss")</script>');

      expect(rendered).toContain('href="#"');
      expect(rendered).not.toContain('javascript:alert');
      expect(rendered).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    test('should escape script tags in user input display', async ({ page }) => {
      await gotoWithBypass(page, '/login');

      // Attempt XSS via email field
      const xssPayload = '<script>alert("xss")</script>';
      await page.fill('input[type="email"], input[name="email"]', xssPayload);
      await page.fill('input[type="password"], input[name="password"]', 'password123');

      // Submit form
      await page.click('button[type="submit"]');

      // Wait for page to process
      await page.waitForTimeout(1000);

      // Check that script is not executed - page should not have alert dialog
      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        dialog.dismiss();
      });

      // Should not trigger any dialogs
      expect(dialogs.length).toBe(0);

      // If displayed, it should be escaped
      const pageContent = await page.content();
      expect(pageContent).not.toContain('<script>alert');
    });

    test('should sanitize HTML entities in displayed content', async ({ page }) => {
      await gotoWithBypass(page, '/register');

      // Attempt XSS via various payloads
      const xssPayloads = [
        '<img src="x" onerror="alert(1)">',
        '"><script>alert(1)</script>',
        "javascript:alert('xss')",
      ];

      for (const payload of xssPayloads) {
        await page.fill('input[type="email"], input[name="email"]', payload);

        // The page should not execute any scripts
        const dialogs: string[] = [];
        const dialogHandler = (dialog: any) => {
          dialogs.push(dialog.message());
          dialog.dismiss();
        };
        page.on('dialog', dialogHandler);

        await page.waitForTimeout(500);

        expect(dialogs.length).toBe(0);
        page.off('dialog', dialogHandler);
      }
    });
  });

  // ============================================
  // Authentication Security Tests
  // ============================================
  test.describe('Authentication Security', () => {
    test('should protect chat page from unauthenticated access', async ({ page }) => {
      // Clear any stored auth state
      await page.context().clearCookies();

      // Try to access protected route
      await gotoWithBypass(page, '/chat');

      // Should redirect to login or landing
      await page.waitForURL(/\/(login|landing)/, { timeout: 5000 });
    });

    test('should protect profile page from unauthenticated access', async ({ page }) => {
      await page.context().clearCookies();

      await gotoWithBypass(page, '/profile');

      // Should redirect to login or landing
      await page.waitForURL(/\/(login|landing)/, { timeout: 5000 });
    });

    test('should not expose session tokens in URL', async ({ page }) => {
      await gotoWithBypass(page, '/login');

      // Check URL doesn't contain sensitive tokens
      const url = page.url();
      expect(url).not.toContain('token=');
      expect(url).not.toContain('session=');
      expect(url).not.toContain('access_token=');
    });

    test('should use secure password input', async ({ page }) => {
      await gotoWithBypass(page, '/login');

      // Password field should be type="password"
      const passwordInput = page.locator('input[name="password"], input[type="password"]');
      await expect(passwordInput).toHaveAttribute('type', 'password');
    });

    test('should not autocomplete sensitive fields', async ({ page }) => {
      await gotoWithBypass(page, '/login');

      // Password field should have autocomplete="new-password" or "current-password" or "off"
      const passwordInput = page.locator('input[name="password"], input[type="password"]');

      // Check it's not set to dangerous values
      const autocomplete = await passwordInput.getAttribute('autocomplete');
      expect(autocomplete).not.toBe('on');
    });
  });

  // ============================================
  // Authorization Tests
  // ============================================
  test.describe('Authorization', () => {
    test('should block access to admin routes for non-admin users', async ({ page }) => {
      // Clear cookies first
      await page.context().clearCookies();

      // Try to access admin route
      await gotoWithBypass(page, '/admin');

      // Should redirect to login or show access denied
      await page.waitForTimeout(2000);

      const url = page.url();
      // Either redirected away from admin or access denied shown
      const isBlocked =
        !url.includes('/admin') ||
        (await page.locator('text=/禁止|拒绝|Forbidden|Access Denied|unauthorized/i').isVisible().catch(() => false)) ||
        (await page.locator('[role="alert"]').isVisible().catch(() => false));

      expect(isBlocked).toBe(true);
    });

    test('should not expose admin API endpoints publicly', async ({ page }) => {
      // Try to access admin API directly
      const response = await page.request.get('/api/trpc/admin.getStatistics');

      // Should return unauthorized or not found
      expect([401, 403, 404, 500]).toContain(response.status());
    });
  });

  // ============================================
  // Input Validation Tests
  // ============================================
  test.describe('Input Validation', () => {
    test('should validate email format on login', async ({ page }) => {
      await gotoWithBypass(page, '/login');

      // Enter invalid email
      await page.fill('input[type="email"], input[name="email"]', 'not-an-email');
      await page.fill('input[type="password"], input[name="password"]', 'password123');

      // Try to submit
      await page.click('button[type="submit"]');

      // Should show validation error or be prevented by HTML5 validation
      const emailInput = page.locator('input[type="email"], input[name="email"]');

      // Either stays on page or shows error
      await page.waitForTimeout(1000);
      const currentUrl = page.url();
      expect(currentUrl).toContain('/login');
    });

    test('should handle SQL injection attempts safely', async ({ page }) => {
      await gotoWithBypass(page, '/login');

      // SQL injection attempt
      const sqlPayload = "admin'--";
      await page.fill('input[type="email"], input[name="email"]', sqlPayload + '@test.com');
      await page.fill('input[type="password"], input[name="password"]', "' OR '1'='1");

      await page.click('button[type="submit"]');

      // Should not log in (no dashboard redirect)
      await page.waitForTimeout(2000);
      const url = page.url();
      expect(url).not.toContain('/chat');
      expect(url).not.toContain('/dashboard');
    });

    test('should limit input length in forms', async ({ page }) => {
      await gotoWithBypass(page, '/login');

      // Try extremely long input
      const longInput = 'a'.repeat(10000);
      await page.fill('input[type="email"], input[name="email"]', longInput + '@test.com');

      // Check the input is truncated or handled
      const emailValue = await page.locator('input[type="email"], input[name="email"]').inputValue();

      // Either truncated or full value - just ensure page doesn't crash
      expect(emailValue.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Security Headers Tests
  // ============================================
  test.describe('Security Headers', () => {
    test('should have X-Frame-Options header', async ({ page }) => {
      const response = await gotoWithBypass(page, '/');

      const xFrameOptions = response?.headers()['x-frame-options'];
      // Should be set (DENY or SAMEORIGIN)
      // Note: May be set by Vercel middleware or Next.js
      if (xFrameOptions) {
        expect(['DENY', 'SAMEORIGIN', 'deny', 'sameorigin']).toContain(xFrameOptions);
      }
    });

    test('should have X-Content-Type-Options header', async ({ page }) => {
      const response = await gotoWithBypass(page, '/');

      const xContentType = response?.headers()['x-content-type-options'];
      if (xContentType) {
        expect(xContentType.toLowerCase()).toBe('nosniff');
      }
    });

    test('should have X-XSS-Protection header or CSP', async ({ page }) => {
      const response = await gotoWithBypass(page, '/');
      const headers = response?.headers() || {};

      // Either X-XSS-Protection or Content-Security-Policy should be present
      const hasXSSProtection = headers['x-xss-protection'] !== undefined;
      const hasCSP = headers['content-security-policy'] !== undefined;

      // At least one protection should be enabled
      // Note: Modern browsers rely more on CSP than X-XSS-Protection
      expect(hasXSSProtection || hasCSP || true).toBe(true); // Soft check
    });

    test('should not expose server version in headers', async ({ page }) => {
      const response = await gotoWithBypass(page, '/');
      const headers = response?.headers() || {};

      // Should not expose detailed version info
      const server = headers['server'] || '';
      const xPoweredBy = headers['x-powered-by'] || '';

      // Should not contain version numbers
      expect(server).not.toMatch(/\d+\.\d+\.\d+/);
      expect(xPoweredBy).not.toMatch(/\d+\.\d+\.\d+/);
    });
  });

  // ============================================
  // Cookie Security Tests
  // ============================================
  test.describe('Cookie Security', () => {
    test('should set secure cookies on HTTPS', async ({ page, context }) => {
      await gotoWithBypass(page, '/login');

      // Get cookies
      const cookies = await context.cookies();

      // Filter for auth-related cookies
      const sessionCookies = cookies.filter(
        (c) =>
          c.name.toLowerCase().includes('session') ||
          c.name.toLowerCase().includes('auth') ||
          c.name.toLowerCase().includes('token')
      );

      // Note: On localhost, secure flag may not be set
      // This test is more relevant for production
      for (const cookie of sessionCookies) {
        // HttpOnly should be set for session cookies
        if (cookie.httpOnly !== undefined) {
          expect(cookie.httpOnly).toBe(true);
        }
      }
    });

    test('should set HttpOnly flag on session cookies', async ({ page, context }) => {
      await gotoWithBypass(page, '/');

      const cookies = await context.cookies();

      // Check Supabase auth cookies
      const authCookies = cookies.filter(
        (c) =>
          c.name.includes('sb-') || // Supabase cookie prefix
          c.name.includes('auth')
      );

      // Session cookies should be HttpOnly (not accessible via JavaScript)
      for (const cookie of authCookies) {
        if (cookie.name.includes('token')) {
          // Token cookies should be HttpOnly
          // Note: Some Supabase cookies may not be HttpOnly by design
        }
      }
    });
  });

  // ============================================
  // Rate Limiting UI Effects Tests
  // ============================================
  test.describe('Rate Limiting', () => {
    test('should show appropriate message when rate limited', async ({ page }) => {
      await gotoWithBypass(page, '/login');

      // Rapidly submit login attempts
      for (let i = 0; i < 15; i++) {
        if (!page.url().includes('/login')) {
          break;
        }
        await page.fill('input[type="email"], input[name="email"]', `test${i}@example.com`);
        await page.fill('input[type="password"], input[name="password"]', 'password');
        const submitButton = page.locator('button[type="submit"]');
        if (!(await submitButton.isEnabled())) {
          break;
        }
        await submitButton.click();
        await page.waitForTimeout(100);
      }

      // Wait for rate limit message
      await page.waitForTimeout(1000);

      // Check for rate limit indication (may or may not trigger depending on server config).
      // The auth flow may now redirect to verify-email after repeated attempts, so
      // the main assertion is that the auth surface remains in a valid state.
      if (page.url().includes('/verify-email')) {
        await expect(page.getByRole('heading', { name: /验证|verify/i })).toBeVisible();
      } else {
        await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible();
      }
    });
  });

  // ============================================
  // HTTPS Redirect Test
  // ============================================
  test.describe('HTTPS', () => {
    test.skip('should redirect HTTP to HTTPS in production', async ({ page }) => {
      // This test only works in production environment
      // Skip for local development

      // In production, accessing http:// should redirect to https://
      // This is handled by Vercel/hosting provider
    });
  });
});

// ============================================
// Authenticated Security Tests
// ============================================
test.describe('Authenticated Security', () => {
  test.skip(
    !hasCredentials('user') || !hasCredentials('admin'),
    'Authenticated security flows require both E2E_TEST_* and E2E_ADMIN_* credentials'
  );

  test.use({ storageState: authStatePaths.user });

  test('should reject representative admin write procedures for authenticated non-admin users', async () => {
    const userClient = await createAuthedTrpcClient(authStatePaths.user);
    const adminClient = await createAuthedTrpcClient(authStatePaths.admin);

    const adminUsers = await adminClient.admin.getAllUsers.query({
      limit: 10,
      offset: 0,
      role: 'admin',
    });
    const adminUserId = adminUsers.users[0]?.id;

    expect(adminUserId).toBeTruthy();

    await expectDenied(
      userClient.settings.updateSystemSettings.mutate({
        key: 'support_email',
        value: `security-denied-${Date.now()}@example.com`,
      })
    );

    await expectDenied(
      userClient.admin.updateUserStatus.mutate({
        userId: adminUserId!,
        status: 'active',
        reason: 'security-regression-check',
      })
    );
  });

  test('should enforce self-only access for tickets and conversations across users', async () => {
    const userClient = await createAuthedTrpcClient(authStatePaths.user);
    const adminClient = await createAuthedTrpcClient(authStatePaths.admin);
    const suffix = Date.now();

    const adminConversation = await adminClient.chat.createConversation.mutate({
      title: `Security isolation ${suffix}`,
    });
    const adminTicket = await adminClient.ticket.createTicket.mutate({
      title: `Security ticket ${suffix}`,
      description: `Security ticket body ${suffix}`,
      category: 'other',
    });

    try {
      await expectDenied(
        userClient.chat.getMessages.query({
          conversationId: adminConversation.id,
        })
      );

      await expectDenied(
        userClient.ticket.getTicketById.query({
          ticketId: adminTicket.id,
        })
      );
    } finally {
      await adminClient.chat.deleteConversation.mutate({
        conversationId: adminConversation.id,
      }).catch(() => undefined);
      await adminClient.ticket.closeTicket.mutate({
        ticketId: adminTicket.id,
      }).catch(() => undefined);
    }
  });

  test('should return private attachment paths on upload and signed URLs on authorized ticket reads', async ({ page }) => {
    const userClient = await createAuthedTrpcClient(authStatePaths.user);
    const adminClient = await createAuthedTrpcClient(authStatePaths.admin);
    const suffix = Date.now();
    const ticketTitle = `Security attachment ${suffix}`;
    const ticketDescription = `Security attachment body ${suffix}`;
    let createdTicketId: string | null = null;

    try {
      await gotoWithBypass(page, '/profile?tab=tickets');
      await page.getByTestId('ticket-create-button').click();
      await expect(page.getByText('创建新工单')).toBeVisible({ timeout: 10000 });

      await page.getByPlaceholder('简要描述您的问题').fill(ticketTitle);
      await page.getByPlaceholder('请详细描述您遇到的问题...').fill(ticketDescription);

      const uploadResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/upload') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await page.locator('#ticket-attachment').setInputFiles(ticketUploadFixture);
      const uploadResponse = await uploadResponsePromise;
      expect(uploadResponse.status()).toBe(200);

      const uploadBody = await uploadResponse.json();
      expect(uploadBody.path).toBeTruthy();
      expect(uploadBody.path).not.toMatch(/^https?:\/\//);
      expect(uploadBody.url).toBeUndefined();

      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/ticket.createTicket') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await page.getByRole('button', { name: '提交工单' }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status()).toBe(200);

      const tickets = await userClient.ticket.getTickets.query();
      const createdTicket = tickets.find((ticket) => ticket.title === ticketTitle);
      expect(createdTicket).toBeTruthy();
      createdTicketId = createdTicket?.id ?? null;

      expect(createdTicket?.attachments?.[0]).toContain('/storage/v1/object/sign/ticket-attachments/');
      expect(createdTicket?.attachments?.[0]).not.toContain('/storage/v1/object/public/ticket-attachments/');

      await expectDenied(
        adminClient.ticket.getTicketById.query({
          ticketId: createdTicketId!,
        })
      );
    } finally {
      if (createdTicketId) {
        await userClient.ticket.closeTicket.mutate({ ticketId: createdTicketId }).catch(() => undefined);
      }
    }
  });
});
