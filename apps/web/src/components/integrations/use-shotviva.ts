/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { READ_RETRY } from '@/trpc/read-retry';
import { connectMessage } from '@/lib/integrations/catalog';

/** INTEGRATION-SHOTVIVA PR C: the signed-in user's Shotviva connection, and connecting / disconnecting it. */
export function useShotviva() {
  const status = trpc.connectors.shotvivaStatus.useQuery(undefined, { staleTime: 30_000, ...READ_RETRY });
  const utils = trpc.useUtils();
  const disconnect = trpc.connectors.shotvivaDisconnect.useMutation({ onSuccess: () => utils.connectors.shotvivaStatus.invalidate() });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Asks the server for Shotviva's authorize page (it sets the state cookie) and goes there. */
  const connect = async () => {
    if (connecting) return;
    setConnecting(true); setError(null);
    const started = await startShotvivaConnect();
    if ('url' in started) { window.location.assign(started.url); return; }
    setError(started.message);
    setConnecting(false);
  };
  return { status, connect, connecting, error, disconnect };
}
export type ShotvivaState = ReturnType<typeof useShotviva>;

/** The connect route's answer: Shotviva's authorize address to go to, or what to tell the user. */
export async function startShotvivaConnect(send: typeof fetch = fetch): Promise<{ url: string } | { message: string }> {
  const fallback = connectMessage({ error: 'SHOTVIVA_UNAVAILABLE' })!.text;
  try {
    const response = await send('/api/connectors/shotviva/connect', { method: 'POST', credentials: 'same-origin' });
    const body = await response.json().catch(() => null) as { url?: unknown; error?: unknown } | null;
    if (response.ok && typeof body?.url === 'string' && /^https:\/\//.test(body.url)) return { url: body.url };
    return { message: connectMessage({ error: typeof body?.error === 'string' ? body.error : 'SHOTVIVA_UNAVAILABLE' })?.text ?? fallback };
  } catch { return { message: fallback }; }
}
