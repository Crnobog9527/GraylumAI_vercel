/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createServiceRoleSupabaseClient } from '@repo/api/src/services/stripe';
import { readPostForMeWebhookSecret } from '@repo/api/src/services/publishMonitor/secrets';
import { handlePostForMeWebhook } from '@repo/api/src/services/publishMonitor/webhook';

export const runtime = 'nodejs';

/** Post for Me events (plan §4.1); authenticated by the shared secret header, answered within the provider's timeout. */
export async function POST(request: Request) {
  try {
    const client = createServiceRoleSupabaseClient();
    const secret = await readPostForMeWebhookSecret(client);
    const result = await handlePostForMeWebhook(request, secret ?? undefined, () => client);
    return NextResponse.json(result.body, { status: result.status });
  } catch {
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE' }, { status: 503 });
  }
}
