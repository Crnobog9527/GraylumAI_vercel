/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { meteringBlocks, MeteringReviewError, reviewMeteringBlock } from './meteringBlocks';

/* Deep review 2026-11-11, finding 10: the Node side of the metering block's way out (the database rules are
 * packages/db/tests/turn-core/metering-review-local.mjs). */
const MODEL = '00000000-0000-4000-8000-000000000020', ADMIN = '00000000-0000-4000-8000-000000000001';
const REQUEST = '00000000-0000-4000-8000-000000000002';
const block = { modelId: MODEL, model: 'Sonnet', calls: 2, firstAt: '2026-11-11T01:00:00+00:00', lastAt: '2026-11-11T02:00:00+00:00', turnId: 7,
  upperUsd: '0.020000000000', nominalUsd: '0.010000000000', actualUsd: '0.050000000000' };
const client = (answer: { data: unknown; error: unknown }) => ({ rpc: vi.fn(async (...call: unknown[]) => { void call; return answer; }) });

describe('the models held by a metering block', () => {
  it('lists them as the database gives them, and an empty list as none', async () => {
    const db = client({ data: [block, { ...block, model: null, nominalUsd: null, actualUsd: null }], error: null });
    expect(await meteringBlocks(db as never)).toEqual({ available: true,
      blocks: [block, { ...block, model: null, nominalUsd: null, actualUsd: null }] });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('admin_metering_blocks');
    expect(await meteringBlocks(client({ data: [], error: null }) as never)).toEqual({ available: true, blocks: [] });
  });

  it('a read that fails, or a shape it does not know, is unavailable and never "none"', async () => {
    expect(await meteringBlocks(client({ data: null, error: { code: 'PGRST202', message: 'no function' } }) as never)).toEqual({ available: false });
    expect(await meteringBlocks(client({ data: [{ ...block, extra: 1 }], error: null }) as never)).toEqual({ available: false });
    expect(await meteringBlocks(client({ data: null, error: null }) as never)).toEqual({ available: false });
  });
});

describe('the admin review that lets a model through again', () => {
  const input = { modelId: MODEL, adminId: ADMIN, requestId: REQUEST };

  it('passes the model, the admin and the request, and returns how many receipts it reviewed (0 for a repeat)', async () => {
    const db = client({ data: { modelId: MODEL, reviewed: 2 }, error: null });
    expect(await reviewMeteringBlock(db as never, input)).toEqual({ modelId: MODEL, reviewed: 2 });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('admin_metering_review', { p_model_id: MODEL, p_admin_id: ADMIN, p_request_id: REQUEST });
    expect(await reviewMeteringBlock(client({ data: { modelId: MODEL, reviewed: 0 }, error: null }) as never, input))
      .toEqual({ modelId: MODEL, reviewed: 0 });
  });

  it('a refusal keeps its code; any other failure never shows database text', async () => {
    const denied = reviewMeteringBlock(client({ data: null, error: { message: 'TURN_ADMIN_DENIED' } }) as never, input);
    await expect(denied).rejects.toMatchObject({ code: 'TURN_ADMIN_DENIED' });
    const broken = reviewMeteringBlock(client({ data: null, error: { message: 'relation "turn_calls" does not exist' } }) as never, input);
    await expect(broken).rejects.toBeInstanceOf(MeteringReviewError);
    await expect(broken).rejects.toMatchObject({ code: 'TURN_METERING_REVIEW_FAILED', message: 'TURN_METERING_REVIEW_FAILED' });
    await expect(reviewMeteringBlock(client({ data: { reviewed: 'x' }, error: null }) as never, input))
      .rejects.toMatchObject({ code: 'TURN_METERING_REVIEW_FAILED' });
  });
});
