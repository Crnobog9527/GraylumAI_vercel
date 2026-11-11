/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { REPLY_LOCALES } from './replyLocales';

// The values, labels and plain checks are in replyLocales.ts, which the browser loads on every page without zod.
// Server code and input schemas keep importing from here.
export * from './replyLocales';

/** The input schema of a reply language (tRPC inputs, stored settings). */
export const replyLocale = z.enum(REPLY_LOCALES);
