/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { BrowserContext, Page } from '@playwright/test';

function isBenignArtifactCloseError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes('ENOENT') &&
    error.message.includes('.playwright-artifacts-') &&
    (error.message.includes('.trace') ||
      error.message.includes('.zip') ||
      error.message.includes('.network') ||
      error.message.includes('recording'))
  );
}

export async function safeCloseContext(context: BrowserContext | null | undefined) {
  if (!context) {
    return;
  }

  try {
    await context.close();
  } catch (error) {
    if (!isBenignArtifactCloseError(error)) {
      throw error;
    }
  }
}

export async function safeClosePage(page: Page | null | undefined) {
  if (!page) {
    return;
  }

  try {
    await page.close();
  } catch (error) {
    if (!isBenignArtifactCloseError(error)) {
      throw error;
    }
  }
}
