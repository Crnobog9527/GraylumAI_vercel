/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { after } from 'next/server';
import { registerPvuvScheduler } from '@repo/api/src/services/analytics/pvuv';

/**
 * ANALYTICS-PVUV: payment code queues its statistics with this scheduler (Next `after`), so they run once the response is sent
 * and a webhook receipt or payment recovery never waits for them. Imported for its effect by the routes that deliver payments.
 */
registerPvuvScheduler(task => after(task));
