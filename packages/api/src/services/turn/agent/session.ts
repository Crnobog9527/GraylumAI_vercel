/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export interface SessionRpc {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
