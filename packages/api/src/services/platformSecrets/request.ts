/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformSecretSlot } from './slots';

type Client = Pick<SupabaseClient, 'rpc'>;
type Reads = Map<PlatformSecretSlot, Promise<string | null>>;
const requests = new AsyncLocalStorage<WeakMap<Client, Reads>>();

/** The HTTP/advance owner starts a new scope. Nothing here is shared with its next request.
 * Async resources created inside it (including a streamed reply) keep this request's scope. */
export function withPlatformSecretRequest<T>(work: () => T): T {
  return requests.run(new WeakMap(), work);
}

/** Reuse only this request's same client/slot, including an empty slot or failed bounded read.
 * Without an explicit request boundary, fresh continues to read every time. */
export function requestSecretRead(client: Client, slot: PlatformSecretSlot, read: () => Promise<string | null>) {
  const request = requests.getStore();
  if (!request) return read();
  let reads = request.get(client);
  if (!reads) {
    reads = new Map();
    request.set(client, reads);
  }
  let pending = reads.get(slot);
  if (!pending) {
    pending = read();
    reads.set(slot, pending);
  }
  return pending;
}
