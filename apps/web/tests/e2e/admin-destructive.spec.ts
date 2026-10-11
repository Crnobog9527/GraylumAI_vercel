/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test } from '@playwright/test';
import { authStatePaths, getCredentials, hasCredentials } from './support/auth';
import { safeCloseContext } from './support/contextCleanup';
import { gotoWithBypass } from './support/deploymentProtection';
import { createIssueMonitor, writeFlowAudit } from './support/monitoring';

const destructiveGateEnabled = process.env.ENABLE_PARITY_DESTRUCTIVE_E2E === 'true';

function normalizeUserRoleLabel(label: string | null | undefined): '管理员' | '普通用户' {
  return label?.includes('管理员') ? '管理员' : '普通用户';
}

async function selectAdminUserRole(
  page: import('@playwright/test').Page,
  userId: string,
  targetRoleLabel: '管理员' | '普通用户',
) {
  const roleTrigger = page.getByTestId(`admin-user-role-${userId}`);
  const currentLabel = normalizeUserRoleLabel(await roleTrigger.textContent());
  if (currentLabel === targetRoleLabel) {
    return;
  }

  const updateResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/trpc/admin.updateUserRole') &&
      response.request().method() === 'POST',
    { timeout: 30000 },
  );
  await roleTrigger.click();
  await page.getByRole('option', { name: targetRoleLabel }).click();
  const updateResponse = await updateResponsePromise;
  expect(updateResponse.status()).toBe(200);
  await expect
    .poll(async () => normalizeUserRoleLabel(await roleTrigger.textContent()), { timeout: 15000 })
    .toBe(targetRoleLabel);
}

async function reloadUserSurface(page: import('@playwright/test').Page) {
  // Chat/profile pages keep background requests alive long enough that
  // Playwright's networkidle heuristic becomes flaky in destructive flows.
  await page.reload({ waitUntil: 'domcontentloaded' });
}

test.describe('Admin Destructive Flows', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authStatePaths.admin });
  test.skip(!hasCredentials('admin'), 'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required for destructive admin flows');

  test('should remain gated until dedicated destructive fixtures are enabled', async () => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );
  });

  test('should run diagnostics record cleanup behind the destructive gate', async ({ page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Diagnostics cleanup flow completed';

    try {
      steps.push('Open /admin/diagnostics');
      await gotoWithBypass(page, '/admin/diagnostics');
      await expect(page).toHaveURL(/\/admin\/diagnostics/);

      const noPersistedHistory = await page.getByText('暂无历史记录').isVisible().catch(() => false);
      if (noPersistedHistory) {
        steps.push('Verify diagnostics cleanup remains safely idle when no persisted history exists');
        await expect(page.getByTestId('admin-diagnostics-cleanup-status')).toContainText('尚未执行诊断记录清理', { timeout: 15000 });
      } else {
        steps.push('Execute diagnostic history cleanup and verify visible feedback');
        page.once('dialog', (dialog) => dialog.accept());
        const cleanupResponsePromise = page.waitForResponse(
          (response) =>
            response.url().includes('/api/trpc/diagnostics.cleanupOldResults') &&
            response.request().method() === 'POST',
          { timeout: 30000 },
        );
        await page.getByTestId('admin-diagnostics-cleanup-trigger').click();
        const cleanupResponse = await cleanupResponsePromise;
        expect(cleanupResponse.status()).toBe(200);
        await expect(page.getByTestId('admin-diagnostics-cleanup-status')).toContainText('已清理', { timeout: 15000 });
      }

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown diagnostics cleanup failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-diagnostics-destructive-cleanup',
          role: 'admin',
          route: '/admin/diagnostics',
          expected: 'Admin destructive cleanup can remove old diagnostic records only when the explicit parity gate is enabled.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should publish a credit package, verify it appears in the user subscription view, then unpublish and restore it before cleanup', async ({ browser, page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );
    test.setTimeout(60000);

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Admin credit package publish rollback flow completed';
    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    const packageName = `Parity Credit Pack ${Date.now()}`;
    let packageId = '';

    try {
      steps.push('Open /admin/packages and create an isolated active credit package');
      await gotoWithBypass(page, '/admin/packages');
      await expect(page).toHaveURL(/\/admin\/packages/);
      await page.getByTestId('admin-credit-package-create-trigger').click();
      await page.getByTestId('credit-package-name-input').fill(packageName);
      await page.getByTestId('credit-package-price-input').fill('12.9');
      await page.getByTestId('credit-package-credits-input').fill('4321');
      await page.getByTestId('credit-package-bonus-input').fill('321');

      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.createPackage') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId('credit-package-save').click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status()).toBe(200);

      const packageRow = page.locator('tbody tr').filter({ hasText: packageName }).first();
      await expect(packageRow).toBeVisible({ timeout: 15000 });
      const rowTestId = await packageRow.getAttribute('data-testid');
      packageId = rowTestId?.replace('admin-credit-package-row-', '') ?? '';
      expect(packageId).not.toBe('');

      steps.push('Open /profile?tab=subscription as the user and verify the credit package appears');
      await gotoWithBypass(userPage, '/profile?tab=subscription');
      await expect(userPage).toHaveURL(/\/profile\?tab=subscription/);
      const userPackage = userPage.getByTestId(`profile-credit-package-${packageId}`);
      await expect(userPackage).toBeVisible({ timeout: 15000 });
      await expect(userPackage.getByTestId('profile-credit-package-name')).toContainText(packageName, { timeout: 15000 });

      steps.push('Disable the credit package and verify it disappears from the user subscription view');
      const disableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updatePackage') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-credit-package-toggle-${packageId}`).click();
      const disableResponse = await disableResponsePromise;
      expect(disableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-credit-package-toggle-${packageId}`)).toContainText('已下架', { timeout: 15000 });

      await reloadUserSurface(userPage);
      await expect(userPage.getByTestId(`profile-credit-package-${packageId}`)).toHaveCount(0, { timeout: 15000 });

      steps.push('Re-enable the credit package and verify it returns to the user subscription view');
      const enableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updatePackage') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-credit-package-toggle-${packageId}`).click();
      const enableResponse = await enableResponsePromise;
      expect(enableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-credit-package-toggle-${packageId}`)).toContainText('已上架', { timeout: 15000 });

      await reloadUserSurface(userPage);
      await expect(userPage.getByTestId(`profile-credit-package-${packageId}`)).toBeVisible({ timeout: 15000 });

      steps.push('Delete the temporary credit package and verify cleanup');
      page.once('dialog', (dialog) => dialog.accept());
      const deleteResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.deletePackage') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-credit-package-delete-${packageId}`).click();
      const deleteResponse = await deleteResponsePromise;
      expect(deleteResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-credit-package-row-${packageId}`)).toHaveCount(0, { timeout: 15000 });

      await reloadUserSurface(userPage);
      await expect(userPage.getByTestId(`profile-credit-package-${packageId}`)).toHaveCount(0, { timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      actual = `Credit package ${packageName} published, unpublished, restored, and cleaned up successfully`;
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin credit package publish rollback failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (packageId) {
        await gotoWithBypass(page, '/admin/packages').catch(() => undefined);
        const lingeringRow = page.getByTestId(`admin-credit-package-row-${packageId}`);
        if (await lingeringRow.count()) {
          page.once('dialog', (dialog) => dialog.accept());
          await page.getByTestId(`admin-credit-package-delete-${packageId}`).click().catch(() => undefined);
        }
      }
      await safeCloseContext(userContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-credit-package-publish-rollback',
          role: 'admin',
          route: '/admin/packages,/profile?tab=subscription',
          expected: 'Admin users can publish a credit package, verify it appears in the user subscription view, unpublish it to hide it, then restore and clean it up safely in preview fixtures.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should disable a membership plan, verify it disappears from the user subscription view, then restore it', async ({ browser, page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );
    test.setTimeout(60000);

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Admin membership plan rollback flow completed';
    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    let targetPlanId = '';
    let targetPlanLevel = '';
    let targetPlanName = '';

    try {
      steps.push('Open /admin/packages and locate an active non-free membership plan');
      await gotoWithBypass(page, '/admin/packages');
      await expect(page).toHaveURL(/\/admin\/packages/);
      await page.getByRole('tab', { name: '会员等级' }).click();

      const activePlanRow = page.locator('tbody tr').filter({ hasText: '已启用' }).filter({ hasNotText: '免费版' }).first();
      await expect(activePlanRow).toBeVisible({ timeout: 15000 });
      const rowTestId = await activePlanRow.getAttribute('data-testid');
      targetPlanId = rowTestId?.replace('admin-membership-plan-row-', '') ?? '';
      expect(targetPlanId).not.toBe('');
      targetPlanName = ((await activePlanRow.textContent()) ?? '').replace(/\s+/g, ' ');
      if (targetPlanName.includes('Gold')) {
        targetPlanLevel = 'gold';
      } else if (targetPlanName.includes('Pro')) {
        targetPlanLevel = 'pro';
      } else {
        targetPlanLevel = 'free';
      }
      expect(targetPlanLevel).not.toBe('free');

      steps.push('Open /profile?tab=subscription as the user and verify the target plan is visible');
      await gotoWithBypass(userPage, '/profile?tab=subscription');
      await expect(userPage).toHaveURL(/\/profile\?tab=subscription/);
      const userPlan = userPage.locator(`[data-plan-id="${targetPlanId}"]`);
      await expect(userPlan).toBeVisible({ timeout: 15000 });

      steps.push('Disable the membership plan and verify it disappears from the user subscription view');
      const disableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updateMembershipPlan') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-membership-plan-toggle-${targetPlanId}`).click();
      const disableResponse = await disableResponsePromise;
      expect(disableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-membership-plan-toggle-${targetPlanId}`)).toContainText('已禁用', { timeout: 15000 });

      await reloadUserSurface(userPage);
      await expect(userPage.locator(`[data-plan-id="${targetPlanId}"]`)).toHaveCount(0, { timeout: 15000 });

      steps.push('Re-enable the membership plan and verify it returns to the user subscription view');
      const enableResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/trpc/admin.updateMembershipPlan') &&
          response.request().method() === 'POST',
        { timeout: 30000 },
      );
      await page.getByTestId(`admin-membership-plan-toggle-${targetPlanId}`).click();
      const enableResponse = await enableResponsePromise;
      expect(enableResponse.status()).toBe(200);
      await expect(page.getByTestId(`admin-membership-plan-toggle-${targetPlanId}`)).toContainText('已启用', { timeout: 15000 });

      await userPage.reload({ waitUntil: 'networkidle' });
      await expect(userPage.locator(`[data-plan-id="${targetPlanId}"]`)).toBeVisible({ timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      actual = `Membership plan ${targetPlanName} disabled and restored successfully`;
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin membership plan rollback failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (targetPlanId) {
        await gotoWithBypass(page, '/admin/packages').catch(() => undefined);
        await page.getByRole('tab', { name: '会员等级' }).click().catch(() => undefined);
        const planToggle = page.getByTestId(`admin-membership-plan-toggle-${targetPlanId}`);
        if (await planToggle.isVisible().catch(() => false)) {
          const label = await planToggle.textContent();
          if (label?.includes('已禁用')) {
            const restoreResponsePromise = page.waitForResponse(
              (response) =>
                response.url().includes('/api/trpc/admin.updateMembershipPlan') &&
                response.request().method() === 'POST',
              { timeout: 30000 },
            ).catch(() => undefined);
            await planToggle.click().catch(() => undefined);
            await restoreResponsePromise;
          }
        }
      }
      await safeCloseContext(userContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-membership-plan-rollback',
          role: 'admin',
          route: '/admin/packages,/profile?tab=subscription',
          expected: 'Admin users can disable a membership plan, verify it disappears from the user subscription view, then restore it safely in preview fixtures.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });

  test('should promote the configured E2E user to admin, verify admin access, then restore the original role', async ({ browser, page }, testInfo) => {
    test.skip(
      !destructiveGateEnabled,
      'Destructive parity coverage is intentionally gated. Enable ENABLE_PARITY_DESTRUCTIVE_E2E=true only with isolated preview fixtures.',
    );
    test.setTimeout(90000);

    const steps: string[] = [];
    const monitor = createIssueMonitor(page);
    let actual = 'Admin user role rollback flow completed';
    const targetEmail = getCredentials('user').email;
    const userContext = await browser.newContext({ storageState: authStatePaths.user });
    const userPage = await userContext.newPage();
    let targetUserId = '';
    let originalRole: '管理员' | '普通用户' = '普通用户';

    try {
      steps.push('Open /admin/users and locate the configured E2E user');
      await gotoWithBypass(page, '/admin/users');
      await expect(page).toHaveURL(/\/admin\/users/);
      await page.getByTestId('admin-users-search').fill(targetEmail);
      const targetRow = page.locator('tbody tr').filter({ hasText: targetEmail }).first();
      await expect(targetRow).toBeVisible({ timeout: 15000 });
      const rowTestId = await targetRow.getAttribute('data-testid');
      targetUserId = rowTestId?.replace('admin-user-row-', '') ?? '';
      expect(targetUserId).not.toBe('');

      originalRole = normalizeUserRoleLabel(
        await page.getByTestId(`admin-user-role-${targetUserId}`).textContent(),
      );

      steps.push('Normalize the target user back to a non-admin baseline before promotion');
      await selectAdminUserRole(page, targetUserId, '普通用户');

      steps.push('Verify the normal user is denied access to /admin before promotion');
      await gotoWithBypass(userPage, '/admin');
      await expect(userPage).toHaveURL(/\/access-denied/, { timeout: 15000 });
      await expect(userPage.getByRole('heading', { name: '访问被拒绝' })).toBeVisible({ timeout: 15000 });

      steps.push('Promote the target user to admin in /admin/users');
      await selectAdminUserRole(page, targetUserId, '管理员');

      steps.push('Verify the promoted user can open /admin successfully');
      await gotoWithBypass(userPage, '/admin');
      await expect(userPage).toHaveURL(/\/admin/, { timeout: 15000 });
      await expect(userPage.getByRole('heading', { name: '管理后台仪表盘' })).toBeVisible({ timeout: 15000 });

      steps.push('Restore the target user role to the original non-admin state');
      await selectAdminUserRole(page, targetUserId, '普通用户');

      steps.push('Verify the restored user loses /admin access again');
      await gotoWithBypass(userPage, '/admin');
      await expect(userPage).toHaveURL(/\/access-denied/, { timeout: 15000 });
      await expect(userPage.getByRole('heading', { name: '访问被拒绝' })).toBeVisible({ timeout: 15000 });

      const blockingIssues = monitor.getIssues('P1');
      expect(blockingIssues, JSON.stringify(blockingIssues, null, 2)).toEqual([]);
      actual = `User ${targetEmail} promoted to admin and restored to ${originalRole} successfully`;
    } catch (error) {
      actual = error instanceof Error ? error.message : 'Unknown admin role rollback failure';
      monitor.addAssertionIssue(actual, 'P1');
      throw error;
    } finally {
      if (targetUserId) {
        await gotoWithBypass(page, '/admin/users').catch(() => undefined);
        await page.getByTestId('admin-users-search').fill(targetEmail).catch(() => undefined);
        await selectAdminUserRole(page, targetUserId, originalRole).catch(() => undefined);
      }
      await safeCloseContext(userContext);
      await writeFlowAudit(
        testInfo,
        {
          title: 'admin-user-role-rollback',
          role: 'admin',
          route: '/admin/users,/admin,/access-denied',
          expected: 'Admin users can temporarily promote the configured E2E user to admin, verify the user gains /admin access, then restore the original role and confirm access is revoked again.',
        },
        actual,
        steps,
        monitor.getIssues(),
      );
    }
  });
});
