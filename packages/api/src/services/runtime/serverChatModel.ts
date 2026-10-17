/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { StagingAccessError } from './stagingErrors';
import type { SettingsRead } from './newWorkGate';

/**
 * UI-MODEL (Owner 2026-10-03, item 50): the input box only shows "Auto" and users cannot switch models.
 * On real hosts an ordinary or auto turn therefore runs on the administrator's primary model; the
 * request's modelId is ignored. Without a configured primary model there is no server choice, so the
 * turn is refused rather than falling back to the request or any other model.
 */
export function serverChatModel(settings: SettingsRead): string {
  if (!settings.ok || !settings.primaryModelId) throw new StagingAccessError('RUNTIME_STAGING_MODEL_DENIED');
  return settings.primaryModelId;
}
