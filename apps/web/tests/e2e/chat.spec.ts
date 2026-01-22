import { test, expect } from '@playwright/test';

test.describe('AI Chat', () => {
  // Use authenticated state for chat tests
  test.use({ storageState: 'tests/.auth/user.json' });

  test.describe('Chat Interface', () => {
    test.skip('should display chat input', async ({ page }) => {
      await page.goto('/chat');

      // Should have message input
      await expect(
        page.locator('textarea, input[type="text"]').filter({ hasText: '' }).first()
      ).toBeVisible();

      // Should have send button
      await expect(
        page.locator('button[type="submit"], button:has-text("发送"), button:has-text("Send")').first()
      ).toBeVisible();
    });

    test.skip('should display credits balance', async ({ page }) => {
      await page.goto('/chat');

      // Should show credits somewhere
      await expect(
        page.locator('[class*="credits"], [class*="balance"], :text-matches("\\d+ 积分")').first()
      ).toBeVisible();
    });

    test.skip('should create new conversation', async ({ page }) => {
      await page.goto('/chat');

      // Click new chat button if exists
      const newChatButton = page.locator('button:has-text("新对话"), button:has-text("New Chat")').first();
      if (await newChatButton.isVisible()) {
        await newChatButton.click();
      }

      // Should have empty chat or welcome message
      await expect(page.locator('.messages, .chat-container, [class*="message"]').first()).toBeVisible();
    });
  });

  test.describe('Send Message', () => {
    test.skip('should send message and receive response', async ({ page }) => {
      await page.goto('/chat');

      // Type a message
      const input = page.locator('textarea, input[type="text"]').first();
      await input.fill('你好，请简单介绍一下你自己');

      // Send message
      await page.click('button[type="submit"], button:has-text("发送"), button:has-text("Send")');

      // Wait for user message to appear
      await expect(
        page.locator('.message-user, [class*="user-message"], [data-role="user"]').first()
      ).toBeVisible({ timeout: 5000 });

      // Wait for AI response (may take longer)
      await expect(
        page.locator('.message-assistant, [class*="assistant-message"], [data-role="assistant"]').first()
      ).toBeVisible({ timeout: 60000 });
    });

    test.skip('should show loading state while waiting for response', async ({ page }) => {
      await page.goto('/chat');

      // Type and send a message
      const input = page.locator('textarea, input[type="text"]').first();
      await input.fill('测试消息');
      await page.click('button[type="submit"], button:has-text("发送")');

      // Should show loading indicator
      await expect(
        page.locator('[class*="loading"], [class*="spinner"], .animate-pulse').first()
      ).toBeVisible({ timeout: 2000 });
    });

    test.skip('should be able to abort message', async ({ page }) => {
      await page.goto('/chat');

      // Send a message
      const input = page.locator('textarea, input[type="text"]').first();
      await input.fill('请写一篇长文章关于人工智能的发展历史');
      await page.click('button[type="submit"]');

      // Wait for abort button to appear
      const abortButton = page.locator('button:has-text("停止"), button:has-text("Stop"), button:has-text("中断")');

      if (await abortButton.isVisible({ timeout: 3000 })) {
        await abortButton.click();

        // Message should be marked as interrupted or stop generating
        await expect(page.locator(':text("已中断"), :text("Stopped")')).toBeVisible({ timeout: 5000 });
      }
    });
  });

  test.describe('Conversation Management', () => {
    test.skip('should show conversation history', async ({ page }) => {
      await page.goto('/chat');

      // Should have sidebar or conversation list
      await expect(
        page.locator('[class*="sidebar"], [class*="conversation-list"], aside').first()
      ).toBeVisible();
    });

    test.skip('should be able to switch conversations', async ({ page }) => {
      await page.goto('/chat');

      // Find conversation items
      const conversations = page.locator('[class*="conversation-item"], [data-testid="conversation"]');

      const count = await conversations.count();
      if (count > 1) {
        // Click second conversation
        await conversations.nth(1).click();

        // URL should change or messages should update
        await page.waitForTimeout(1000);
      }
    });
  });
});
