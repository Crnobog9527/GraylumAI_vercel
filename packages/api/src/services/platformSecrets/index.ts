/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export {
  getPlatformSecret, invalidatePlatformSecret, PlatformSecretError, PLATFORM_SECRET_CACHE_MS,
  type PlatformSecret, type PlatformSecretErrorCode,
} from './reader';
export { PLATFORM_SECRET_SLOTS, PLATFORM_SECRET_ENV_FALLBACK, type PlatformSecretSlot } from './slots';
