/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { adoptable, currentFinalScript, guideRequest, latestVersion, replyOfRequest, scriptSourceTurn, videoRequest, type ContentVersion } from './work-turn-path';

const version = (over: Partial<ContentVersion>): ContentVersion => ({ id: 'a', kind: 'script', version: 1, status: 'final', body: 'b', sourceContentId: null,
  turnId: null, requestId: 'r', ...over });

describe('a work item on the turn path', () => {
  it('finds the turn behind a manual revision, and stops on a broken chain', () => {
    const root = version({ id: 'root', turnId: 7 }), manual = version({ id: 'manual', version: 2, sourceContentId: 'root' });
    expect(currentFinalScript([root, manual])?.id).toBe('manual');
    expect(scriptSourceTurn([root, manual], manual)).toBe(7);
    const loop = [version({ id: 'x', sourceContentId: 'y' }), version({ id: 'y', sourceContentId: 'x' })];
    expect(scriptSourceTurn(loop, loop[0])).toBeNull();
    expect(scriptSourceTurn([], null)).toBeNull();
  });
  it('counts each kind apart', () => {
    expect(latestVersion([version({ version: 3 }), version({ kind: 'storyboard', version: 1 })], 'script')).toBe(3);
    expect(latestVersion([], 'editing')).toBe(0);
  });
  it('offers to adopt only a Skill reply that is not a guide or a package', () => {
    expect(adoptable(true, '写一版')).toBe(true);
    expect(adoptable(false, '写一版')).toBe(false);
    expect(adoptable(true, guideRequest('s', '视频'))).toBe(false);
    expect(adoptable(true, videoRequest('both'))).toBe(false);
  });
  it('names exactly the fields asked for', () => {
    expect(videoRequest('storyboard')).toContain('只含 storyboard 一个字符串字段');
    expect(videoRequest('editing')).toContain('只含 editing 一个字符串字段');
  });
  it('reads a package reply by its request id', () => {
    // A turn resumed after a pause has its own request id; it is found by the request it continues.
    const messages = [{ role: 'user', rootRequestId: 'r', turnId: 2 }, { role: 'assistant', rootRequestId: 'r', turnId: 2 }];
    expect(replyOfRequest(messages, 'r')).toBe(2);
    expect(replyOfRequest(messages, 'other')).toBeNull();
  });
});
