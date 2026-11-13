/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { imageIdempotencyKey, imageToolBytes, imageToolResult, imageTools, type ImageToolCalls } from './imageTools';

const SESSION = '00000000-0000-4000-8000-000000000051';
const JOB = '00000000-0000-4000-8000-0000000000aa';
const succeeded = { status: 'succeeded' as const, jobId: JOB, imageUrl: 'https://abc.r2.cloudflarestorage.com/a?X-Amz-Signature=secret',
  viewUrl: `https://shotviva.test/photos/${JOB}`, creditsCharged: 2, creditsRemaining: 8, freeCreditsRemaining: 0 };
const calls = (over: Partial<ImageToolCalls> = {}): ImageToolCalls => ({ sessionId: SESSION,
  listTemplates: vi.fn(async () => ({ ok: true as const, templates: [] })), generate: vi.fn(async () => succeeded), ...over });
const tools = (input: { usable?: boolean; calls?: ImageToolCalls } = {}) => {
  const onCall = vi.fn();
  const [list, generate] = imageTools({ usable: () => input.usable ?? true, calls: 'calls' in input ? input.calls : calls(), onCall });
  return { list: list!, generate: generate!, onCall };
};

describe('image idempotency key', () => {
  it('is the same for a replayed call and different for another request or call; printable, at most 200 characters', () => {
    const request = { template: 'freeform', copy: { prompt: 'a cup' }, aspect: null };
    const key = imageIdempotencyKey(SESSION, 'call-1', request);
    expect(key).toMatch(new RegExp(`^graylum:${SESSION}:call-1:[0-9a-f]{24}$`));
    expect(imageIdempotencyKey(SESSION, 'call-1', request)).toBe(key);
    expect(imageIdempotencyKey(SESSION, 'call-1', { ...request, copy: { prompt: 'a dog' } })).not.toBe(key);
    expect(imageIdempotencyKey(SESSION, 'call-2', request)).not.toBe(key);
    const odd = imageIdempotencyKey(SESSION, `call ${'é'.repeat(300)}\n${'x'.repeat(300)}`, request);
    expect(odd.length).toBeLessThanOrEqual(200);
    expect(odd).toMatch(/^[\x21-\x7e]+$/);
  });
});

describe('image tools', () => {
  it('generate: one image per reply, keyed by session, call and request; the model never reads the image address', async () => {
    const c = calls();
    const { generate, onCall } = tools({ calls: c });
    const result = JSON.parse(await generate.execute({ template_id: 'freeform', prompt: 'a red cup' }, 'call-1'));
    expect(result).toEqual({ status: 'succeeded', jobId: JOB, creditsCharged: 2, creditsRemaining: 8,
      note: 'The image is shown to the user as a card.' });
    expect(JSON.stringify(result)).not.toContain('r2.cloudflarestorage');
    expect(c.generate).toHaveBeenCalledWith({ idempotencyKey: expect.stringMatching(/^graylum:.+:call-1:/), templateId: 'freeform',
      copy: { prompt: 'a red cup' } });
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(generate.enabled?.()).toBe(false);
    expect(JSON.parse(await generate.execute({ template_id: 'freeform', prompt: 'again' }, 'call-2'))).toMatchObject({ status: 'failed' });
    expect(c.generate).toHaveBeenCalledTimes(1);
  });

  it('a template passes its text fields; freeform without a prompt is refused before Shotviva is asked', async () => {
    const c = calls();
    await tools({ calls: c }).generate.execute({ template_id: 'poster', copy: { title: 'Sale' }, aspect_ratio: '3:4' }, 'c1');
    expect(c.generate).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'poster', copy: { title: 'Sale' }, aspectRatio: '3:4' }));
    const empty = calls();
    expect(JSON.parse(await tools({ calls: empty }).generate.execute({ template_id: 'freeform' }, 'c2')))
      .toMatchObject({ status: 'failed', code: 'invalid_input' });
    expect(empty.generate).not.toHaveBeenCalled();
  });

  it('trimmed or without calls: unavailable, nothing counted, Shotviva not asked', async () => {
    const c = calls();
    const off = tools({ usable: false, calls: c });
    expect(JSON.parse(await off.generate.execute({ template_id: 'freeform', prompt: 'x' }, 'c'))).toMatchObject({ status: 'failed' });
    expect(JSON.parse(await off.list.execute({}, 'c'))).toMatchObject({ status: 'failed' });
    expect(c.generate).not.toHaveBeenCalled(); expect(c.listTemplates).not.toHaveBeenCalled(); expect(off.onCall).not.toHaveBeenCalled();
    expect(JSON.parse(await tools({ calls: undefined }).generate.execute({ template_id: 'freeform', prompt: 'x' }, 'c')))
      .toMatchObject({ status: 'failed' });
  });

  it('a failure is the outcome, never an exception that ends the turn', async () => {
    const thrown = calls({ generate: vi.fn(async () => { throw new Error('boom'); }) });
    expect(JSON.parse(await tools({ calls: thrown }).generate.execute({ template_id: 'freeform', prompt: 'x' }, 'c')))
      .toMatchObject({ status: 'failed', code: 'unavailable' });
    const listFails = calls({ listTemplates: vi.fn(async () => { throw new Error('boom'); }) });
    expect(JSON.parse(await tools({ calls: listFails }).list.execute({}, 'c'))).toEqual({ status: 'failed', code: 'unavailable' });
  });

  it('the template list is short: id, name, category, credits, text fields and ratios only', async () => {
    const template = { id: 'poster', name: 'Poster', category: 'ads', category_path: ['ads'], series: null,
      cover_before_url: 'https://x/a.png', cover_after_url: null,
      credits_cost: 2, fields: { images: { min: 0, max: 0 }, copy: [{ key: 'title', label: 'Title', required: true, max_length: 40 }],
        aspect_ratios: ['3:4'] } };
    const c = calls({ listTemplates: vi.fn(async () => ({ ok: true as const, templates: [template] })) });
    expect(JSON.parse(await tools({ calls: c }).list.execute({}, 'c'))).toEqual({ status: 'ok', items: [{ id: 'poster', name: 'Poster',
      category: 'ads', credits: 2, fields: [{ key: 'title', label: 'Title', required: true, maxLength: 40 }], aspectRatios: ['3:4'] }] });
  });

  it('results say plainly what happened; definitions have a fixed size', () => {
    expect(JSON.parse(imageToolResult({ status: 'running', jobId: JOB, viewUrl: 'https://x' }))).toMatchObject({ status: 'running', jobId: JOB });
    expect(JSON.parse(imageToolResult({ status: 'failed', code: 'IDENTITY_SWAP_REFUSED', topUpUrl: null, jobId: null, refunded: false })))
      .toMatchObject({ status: 'failed', code: 'IDENTITY_SWAP_REFUSED' });
    expect(imageToolBytes()).toBe(imageToolBytes());
    expect(imageToolBytes()).toBeGreaterThan(500);
  });
});
