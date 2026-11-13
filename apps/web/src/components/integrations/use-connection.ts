/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { trpc } from '@/trpc/client';
import { READ_RETRY } from '@/trpc/read-retry';

/** INTEGRATION-BASE: the signed-in user's connection that holds a credential of their own (Feishu Base), and disconnecting it.
 * The status never carries the credential: whether they may connect (Pro/Gold), whether they are, its label and last four. */
export function useConnection(provider: 'feishu_base') {
  const status = trpc.connectors.connectionStatus.useQuery({ provider }, { staleTime: 30_000, ...READ_RETRY });
  const utils = trpc.useUtils();
  const disconnect = trpc.connectors.connectionDisconnect.useMutation({
    onSuccess: () => utils.connectors.connectionStatus.invalidate({ provider }),
  });
  return { provider, status, disconnect };
}
export type ConnectionState = ReturnType<typeof useConnection>;
