/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), list: vi.fn(), sessionPhotos: vi.fn(), grant: vi.fn() }));
vi.mock('../../lib/envValidator', async original => ({ ...(await original<object>()),
  readShotvivaRouteEnv: () => ({ shotvivaBaseUrl: 'https://shotviva.test' }) }));
vi.mock('../connectors/shotviva/images', () => ({ generateImage: mocks.generate, listImageTemplates: mocks.list }));
vi.mock('../chatPhotos/photos', () => ({ sessionPhotos: mocks.sessionPhotos }));
vi.mock('../chatPhotos/grant', () => ({ photoGrantUrl: mocks.grant }));
import { chatToolDeps } from './chatToolDeps';

const ME = '00000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-0000000000a1';
const admin = { admin: true } as never;
const photo = (turnId: number, index: number) => ({ path: `${ME}/${SESSION}.${turnId}.${index}.x.jpg`, turnId, index });
const calls = (origin?: string, current?: Parameters<NonNullable<ReturnType<typeof chatToolDeps>['images']>['calls']>[2]) =>
  chatToolDeps(admin, () => admin, origin).images!.calls(ME, SESSION, current!);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generate.mockResolvedValue({ status: 'succeeded' });
  mocks.sessionPhotos.mockResolvedValue([photo(3, 0), photo(5, 0)]);
  mocks.grant.mockResolvedValue('https://auth-staging.graylum.com/api/chat-photos/shared?p=x&t=y');
});

describe('the image tools\' photos (Owner 2026-11-13: a photo sent now or earlier can make an image)', () => {
  it('the conversation\'s photos with this message\'s once kept, oldest first, each once', async () => {
    const kept = Promise.resolve([photo(9, 1), photo(9, 0), photo(5, 0)]);
    expect(await calls('https://www.graylum.com', { turnId: 9, kept }).photos!()).toEqual({ currentTurnId: 9,
      photos: [photo(3, 0), photo(5, 0), photo(9, 0), photo(9, 1)] });
    expect(mocks.sessionPhotos).toHaveBeenCalledWith(admin, ME, SESSION);
    expect((await calls('https://www.graylum.com', { turnId: 9, kept: null }).photos!()).photos).toEqual([photo(3, 0), photo(5, 0)]);
  });

  it('a chosen photo goes to Shotviva as a few-minutes address on this request\'s own origin', async () => {
    await calls('https://auth-staging.graylum.com').generate({ idempotencyKey: 'k', templateId: 'product', copy: {}, photoPath: photo(5, 0).path });
    expect(mocks.grant).toHaveBeenCalledWith({ client: admin, appOrigin: 'https://auth-staging.graylum.com', profileId: ME,
      sessionId: SESSION, path: photo(5, 0).path });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ profileId: ME, callId: 'k', templateId: 'product',
      image: 'https://auth-staging.graylum.com/api/chat-photos/shared?p=x&t=y' }));
    await calls('https://www.graylum.com').generate({ idempotencyKey: 'k2', templateId: 'freeform', copy: { prompt: 'a cup' } });
    expect(mocks.generate.mock.calls.at(-1)![0]).not.toHaveProperty('image');
  });

  it('a photo that cannot be signed (or no origin) makes no image rather than one without the photo', async () => {
    mocks.grant.mockResolvedValueOnce(null);
    expect(await calls('https://www.graylum.com').generate({ idempotencyKey: 'k', templateId: 'product', copy: {}, photoPath: 'p' }))
      .toMatchObject({ status: 'failed', code: 'unavailable' });
    expect(await calls(undefined).generate({ idempotencyKey: 'k', templateId: 'product', copy: {}, photoPath: 'p' }))
      .toMatchObject({ status: 'failed', code: 'unavailable' });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
