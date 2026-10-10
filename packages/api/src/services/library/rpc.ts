/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
export async function libraryRpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const code = /^LIBRARY_[A-Z_]+$/.test(error.message) ? error.message : 'LIBRARY_UNAVAILABLE';
    throw new TRPCError({ code: 'BAD_REQUEST', message: code });
  }
  return data as T;
}
