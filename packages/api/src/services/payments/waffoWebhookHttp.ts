/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { receiveWaffoWebhook, WAFFO_MAX_BODY_BYTES } from './waffoWebhook';

type Dependencies = {
  config: () => { publicKey: string; storeId: string; merchantNamespace: string } | null;
  database: () => Parameters<typeof receiveWaffoWebhook>[0]['db'];
};

/** Streaming limit applies even when Content-Length is absent or dishonest. */
export async function handleWaffoWebhookHttp(request: Request, deps: Dependencies) {
  const config = deps.config();
  if (!config) return new Response('Webhook unavailable', { status: 503 });
  const signature = request.headers.get('x-waffo-signature');
  if (!signature || !request.body) return new Response('Invalid webhook', { status: 400 });
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > WAFFO_MAX_BODY_BYTES) {
        await reader.cancel();
        return new Response('Webhook too large', { status: 413 });
      }
      parts.push(part.value);
    }
  } catch { return new Response('Invalid webhook', { status: 400 }); }
  finally { reader.releaseLock(); }
  try {
    await receiveWaffoWebhook({ ...config, signature, body: Buffer.concat(parts), db: deps.database() });
    return Response.json({ received: true });
  } catch (error) {
    if (error instanceof Error && (error.message === 'WAFFO_SIGNATURE_INVALID' || error.message === 'WAFFO_SCOPE_MISMATCH'
      || error.message === 'WAFFO_BODY_INVALID' || error instanceof SyntaxError || error.name === 'ZodError')) {
      return new Response('Invalid webhook', { status: 400 });
    }
    // Database/configuration failures remain retryable. Never log raw payload or key material.
    return new Response('Webhook unavailable', { status: 503 });
  }
}
