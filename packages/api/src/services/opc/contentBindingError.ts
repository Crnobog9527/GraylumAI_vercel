/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {throwIfContentErased} from '../accountErasure/content';
import { TRPCError } from '@trpc/server';
import { DatabaseReadError } from '../../lib/databaseReadError';

/** Only the exact database refusal is safe to release as a failed precondition. */
export function throwIfContentBindingRefused(error: { code?: string; message?: string }) {
  if (error.code === 'P0001' && error.message === 'OPC_CONTENT_BINDING') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'OPC_CONTENT_BINDING' });
  }
}

/** The plan's profile limit is a definite business refusal (not a server fault): release it as a 4xx. */
export function throwIfProfileLimitRefused(error: { code?: string; message?: string }) {
  if (error.code === 'P0001' && error.message === 'OPC_PROFILE_LIMIT') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'OPC_PROFILE_LIMIT' });
  }
}

export function throwOpcRpcError(error: { code?: string; message: string }): never {
  throwIfContentErased(error);
  throwIfContentBindingRefused(error);
  throwIfProfileLimitRefused(error);
  // Retain the other bounded business codes used by existing request recovery.
  if (/^(?:OPC|RUNTIME)_[A-Z_]+$/.test(error.message)) throw new Error(error.message);
  throw new DatabaseReadError('OPC_UNAVAILABLE', error.code);
}
