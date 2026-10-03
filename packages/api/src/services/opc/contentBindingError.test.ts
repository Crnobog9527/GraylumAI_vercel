/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { throwIfContentBindingRefused } from './contentBindingError';

it.each([
  { code: 'P0001', message: 'OPC_CONTENT_BINDING: private SQL details' },
  { code: '42501', message: 'OPC_CONTENT_BINDING' },
  { code: '08006', message: 'OPC_CONTENT_BINDING' },
  { message: 'OPC_CONTENT_BINDING' },
  { code: 'P0001', message: 'OPC_REQUEST_CONFLICT' },
])('does not promote an unrecognized database failure to definite refusal: %j', error => {
  expect(() => throwIfContentBindingRefused(error)).not.toThrow();
});
