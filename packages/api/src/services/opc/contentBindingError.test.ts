/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { throwIfContentBindingRefused, throwIfProfileLimitRefused, throwOpcRpcError } from './contentBindingError';

it.each([
  { code: 'P0001', message: 'OPC_CONTENT_BINDING: private SQL details' },
  { code: '42501', message: 'OPC_CONTENT_BINDING' },
  { code: '08006', message: 'OPC_CONTENT_BINDING' },
  { message: 'OPC_CONTENT_BINDING' },
  { code: 'P0001', message: 'OPC_REQUEST_CONFLICT' },
])('does not promote an unrecognized database failure to definite refusal: %j', error => {
  expect(() => throwIfContentBindingRefused(error)).not.toThrow();
});

it('releases only the exact database profile-limit refusal as a 4xx the page can read', () => {
  let caught: unknown;
  try { throwIfProfileLimitRefused({ code: 'P0001', message: 'OPC_PROFILE_LIMIT' }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(TRPCError);
  expect(caught).toMatchObject({ code: 'FORBIDDEN', message: 'OPC_PROFILE_LIMIT' });
  try { throwOpcRpcError({ code: 'P0001', message: 'OPC_PROFILE_LIMIT' }); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code: 'FORBIDDEN', message: 'OPC_PROFILE_LIMIT' });
});

it.each([
  { code: 'P0001', message: 'OPC_PROFILE_LIMIT: private SQL details' },
  { code: 'P0001', message: 'OPC_PROFILE_LIMIT_UNAVAILABLE' },
  { code: '42501', message: 'OPC_PROFILE_LIMIT' },
  { message: 'OPC_PROFILE_LIMIT' },
])('does not promote an unrecognized failure to the profile-limit refusal: %j', error => {
  expect(() => throwIfProfileLimitRefused(error)).not.toThrow();
});
