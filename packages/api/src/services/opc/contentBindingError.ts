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

export function throwOpcRpcError(error: { code?: string; message: string }): never {
  throwIfContentErased(error);
  throwIfContentBindingRefused(error);
  // Retain the other bounded business codes used by existing request recovery.
  if (/^(?:OPC|RUNTIME)_[A-Z_]+$/.test(error.message)) throw new Error(error.message);
  throw new DatabaseReadError('OPC_UNAVAILABLE', error.code);
}
