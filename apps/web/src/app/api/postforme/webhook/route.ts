/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createServiceRoleSupabaseClient } from '@repo/api/src/services/stripe';
import { handlePostForMeWebhook } from '@repo/api/src/services/publishMonitor/webhook';

export const runtime = 'nodejs';

/** Post for Me events (plan §4.1); authenticated by the shared secret header, answered within the provider's timeout. */
export async function POST(request: Request) {
  const result = await handlePostForMeWebhook(request, process.env.POSTFORME_WEBHOOK_SECRET,
    createServiceRoleSupabaseClient);
  return NextResponse.json(result.body, { status: result.status });
}
