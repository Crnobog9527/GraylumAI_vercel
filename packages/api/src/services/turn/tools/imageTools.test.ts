/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { IMAGE_BALANCE_NOTE, IMAGE_SHOWN_NOTE, IMAGE_TOOLS_INSTRUCTIONS, imageIdempotencyKey, imageToolBytes, imageToolResult,
  imageTools, imageTrimNote, type ImageToolCalls } from './imageTools';
import { IMAGE_STEP_REASONS } from '../sse';

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
    expect(result).toEqual({ status: 'succeeded', jobId: JOB, creditsCharged: 2, paidCredits: 8, freeCredits: 0,
      note: `${IMAGE_SHOWN_NOTE} ${IMAGE_BALANCE_NOTE}` });
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
    expect(JSON.parse(await tools({ calls: listFails }).list.execute({}, 'c'))).toMatchObject({ status: 'failed', code: 'unavailable' });
  });

  it('the template list is short: id, name, category, credits, photo, text fields and ratios only', async () => {
    const template = { id: 'poster', name: 'Poster', category: 'ads', category_path: ['ads'], series: null,
      cover_before_url: 'https://x/a.png', cover_after_url: null,
      credits_cost: 2, fields: { images: { min: 0, max: 0 }, copy: [{ key: 'title', label: 'Title', required: true, max_length: 40 }],
        aspect_ratios: ['3:4'] } };
    const c = calls({ listTemplates: vi.fn(async () => ({ ok: true as const, templates: [template] })) });
    expect(JSON.parse(await tools({ calls: c }).list.execute({}, 'c'))).toEqual({ status: 'ok', items: [{ id: 'poster', name: 'Poster',
      category: 'ads', credits: 2, photo: 'none', fields: [{ key: 'title', label: 'Title', required: true, maxLength: 40 }],
      aspectRatios: ['3:4'] }], photos: [] });
  });

  it('results say plainly what happened; definitions have a fixed size', () => {
    expect(JSON.parse(imageToolResult({ status: 'running', jobId: JOB, viewUrl: 'https://x' }))).toMatchObject({ status: 'running', jobId: JOB });
    expect(JSON.parse(imageToolResult({ status: 'failed', code: 'IDENTITY_SWAP_REFUSED', topUpUrl: null, jobId: null, refunded: false })))
      .toMatchObject({ status: 'failed', code: 'IDENTITY_SWAP_REFUSED' });
    expect(imageToolBytes()).toBe(imageToolBytes());
    expect(imageToolBytes()).toBeGreaterThan(500);
  });

  // Owner 2026-11-13: on a failed image the reply repeated the user's whole prompt. The model is told, in the instructions and in
  // every result, to keep it to one sentence and the next step; no result carries the prompt back for it to copy.
  it('no result invites repeating the prompt; a failure asks for one sentence and the next step', async () => {
    const prompt = 'a latte on a textured wooden table, morning light';
    const failures = IMAGE_STEP_REASONS.filter(code => code !== 'running');
    for (const code of failures) {
      const c = calls({ generate: vi.fn(async () => ({ status: 'failed' as const, code, topUpUrl: null, jobId: null, refunded: false })) });
      const text = await tools({ calls: c }).generate.execute({ template_id: 'freeform', prompt }, 'c');
      expect(text, code).not.toContain('latte');
      expect(JSON.parse(text).note, code).toMatch(/In one sentence, tell the user why and what they can do next/);
      expect(JSON.parse(text).note, code).toMatch(/do not repeat the prompt/);
    }
    const others = [await tools({ usable: false }).generate.execute({ template_id: 'freeform', prompt }, 'c'),
      await tools().generate.execute({ template_id: 'freeform', prompt }, 'c'),
      imageToolResult({ status: 'running', jobId: JOB, viewUrl: 'https://x' })];
    for (const text of others) {
      expect(text).not.toContain('latte');
      expect(JSON.parse(text).note).toMatch(/[Dd]o not repeat the prompt/);
    }
    expect(IMAGE_TOOLS_INSTRUCTIONS).toMatch(/never write out the prompt, the description or the template fields/);
    expect(IMAGE_TOOLS_INSTRUCTIONS).toMatch(/say in one sentence why and what the user can do next/);
  });

  // Owner 2026-11-13: the reply said "3 credits left" while the account also had 200+ free credits.
  it('a made image gives both balances apart and asks for both or neither', () => {
    const result = JSON.parse(imageToolResult({ ...succeeded, creditsRemaining: 3, freeCreditsRemaining: 215 }));
    expect(result).toMatchObject({ paidCredits: 3, freeCredits: 215 });
    expect(result).not.toHaveProperty('creditsRemaining');
    expect(result.note).toContain('"付费积分 X、免费积分 Y"');
    expect(result.note).toMatch(/never one alone; or do not mention the balance/);
  });

  // Owner 2026-11-13: "connect Shotviva first" came with no link to do it.
  it('not connected, disconnected or not a member: the result gives the integrations page as a link; other failures do not', () => {
    for (const code of ['not_linked', 'link_revoked', 'membership_required'] as const) {
      const result = JSON.parse(imageToolResult({ status: 'failed', code, topUpUrl: null, jobId: null, refunded: false }));
      expect(result.link, code).toBe('/app/integrations');
      expect(result.note, code).toContain('[去连接 Shotviva](/app/integrations)');
    }
    for (const code of ['quota_exhausted', 'IDENTITY_SWAP_REFUSED', 'unavailable'] as const) {
      const result = JSON.parse(imageToolResult({ status: 'failed', code, topUpUrl: null, jobId: null, refunded: false }));
      expect(result, code).not.toHaveProperty('link');
      expect(result.note, code).not.toContain('/app/integrations');
    }
    expect(imageTrimNote('not_linked')).toContain('[去连接 Shotviva](/app/integrations)');
    expect(imageTrimNote('not_entitled')).toContain('[去连接 Shotviva](/app/integrations)');
    expect(imageTrimNote('capacity')).toBe('');
  });

  it('a template list the account cannot read yet links the integrations page too', async () => {
    const c = calls({ listTemplates: vi.fn(async () => ({ ok: false as const, code: 'not_linked' })) });
    expect(JSON.parse(await tools({ calls: c }).list.execute({}, 'c'))).toMatchObject({ status: 'failed', code: 'not_linked',
      link: '/app/integrations' });
  });
});

// Owner 2026-11-13: a photo the user sent in the conversation, now or earlier, can be a template's photo.
describe('photos', () => {
  const template = (id: string, min: number, max: number) => ({ id, name: id, category: 'c', category_path: ['c'], series: null,
    cover_before_url: null, cover_after_url: null, credits_cost: 3, fields: { images: { min, max }, copy: [], aspect_ratios: ['1:1'] } });
  const photo = (turnId: number, index: number) => ({ path: `me/s.${turnId}.${index}.x.jpg`, turnId, index });
  const conversation = { photos: [photo(3, 0), photo(3, 1), photo(8, 0)], currentTurnId: 8 };

  it('the list says which templates take a photo and numbers the conversation\'s photos, oldest first, this message\'s marked', async () => {
    const c = calls({ listTemplates: vi.fn(async () => ({ ok: true as const, templates: [template('product', 1, 1), template('poster', 0, 1),
      template('freeform', 0, 0)] })), photos: vi.fn(async () => conversation) });
    const listed = JSON.parse(await tools({ calls: c }).list.execute({}, 'c'));
    expect(listed.items.map((item: { id: string; photo: string }) => [item.id, item.photo]))
      .toEqual([['product', 'required'], ['poster', 'optional'], ['freeform', 'none']]);
    expect(listed.photos).toEqual([{ photo: 1, sentWith: 'an earlier message' }, { photo: 2, sentWith: 'an earlier message' },
      { photo: 3, sentWith: 'this message' }]);
    expect(JSON.stringify(listed)).not.toContain('.jpg');
    const failing = calls({ listTemplates: vi.fn(async () => ({ ok: true as const, templates: [] })),
      photos: vi.fn(async () => { throw new Error('down'); }) });
    expect(JSON.parse(await tools({ calls: failing }).list.execute({}, 'c')).photos).toEqual([]);
  });

  it('generate takes the photo by its number, and the photo is part of the request\'s idempotency key', async () => {
    const c = calls({ photos: vi.fn(async () => conversation) });
    await tools({ calls: c }).generate.execute({ template_id: 'product', photo: 2 }, 'call-1');
    expect(c.generate).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'product', photoPath: photo(3, 1).path }));
    const withPhoto = (c.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0].idempotencyKey;
    const plain = calls({ photos: vi.fn(async () => conversation) });
    await tools({ calls: plain }).generate.execute({ template_id: 'product' }, 'call-1');
    expect((plain.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toHaveProperty('photoPath');
    expect((plain.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0].idempotencyKey).not.toBe(withPhoto);
  });

  it('a number that is no photo of this conversation: asked to list them, Shotviva not asked, nothing counted', async () => {
    const c = calls({ photos: vi.fn(async () => conversation) });
    const t = tools({ calls: c });
    expect(JSON.parse(await t.generate.execute({ template_id: 'product', photo: 4 }, 'c'))).toMatchObject({ status: 'failed',
      code: 'invalid_input', note: expect.stringContaining('list_image_templates') });
    expect(c.generate).not.toHaveBeenCalled();
    expect(t.onCall).not.toHaveBeenCalled();
    expect(t.generate.enabled?.()).toBe(true);
    const none = calls({ photos: undefined });
    expect(JSON.parse(await tools({ calls: none }).generate.execute({ template_id: 'product', photo: 1 }, 'c')))
      .toMatchObject({ code: 'invalid_input' });
  });

  it('the instructions and descriptions tell the model how to use a photo sent earlier', () => {
    expect(IMAGE_TOOLS_INSTRUCTIONS).toMatch(/in this message or an earlier one/);
    expect(IMAGE_TOOLS_INSTRUCTIONS).toMatch(/call list_image_templates first and pass the photo's number/);
  });
});

