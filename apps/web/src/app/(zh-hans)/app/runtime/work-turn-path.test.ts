/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { currentFinalScript, guideRequest, latestVersion, SAVE_KINDS, saveRefusal, saveStatus, savable, VIDEO_PACKAGE, type ContentVersion } from './work-turn-path';

const version = (over: Partial<ContentVersion>): ContentVersion => ({ id: 'a', kind: 'script', version: 1, status: 'final', body: 'b', sourceContentId: null,
  turnId: null, requestId: 'r', ...over });

describe('a work item on the turn path', () => {
  it('reads the newest final script', () => {
    const root = version({ id: 'root', turnId: 7 }), manual = version({ id: 'manual', version: 2, sourceContentId: 'root' });
    expect(currentFinalScript([root, manual, version({ id: 'draft', version: 3, status: 'draft' })])?.id).toBe('manual');
    expect(currentFinalScript([])).toBeNull();
  });
  it('counts each kind apart', () => {
    expect(latestVersion([version({ version: 3 }), version({ kind: 'storyboard', version: 1 })], 'script')).toBe(3);
    expect(latestVersion([], 'editing')).toBe(0);
  });
  // CONTENT-CONVERSATION-2: any reply of the conversation can be saved, whatever Skill wrote it; the opening guide and an old package cannot.
  it('offers a save for every reply but the guide and an old package', () => {
    expect(savable('写一版口播稿')).toBe(true);
    expect(savable(null)).toBe(true);
    expect(savable(guideRequest('s', '视频'))).toBe(false);
    expect(savable(VIDEO_PACKAGE + ' 只生成分镜')).toBe(false);
  });
  it('saves a video reply as script, storyboard or editing, an article or image-text reply as its body, an unknown type not at all', () => {
    expect(SAVE_KINDS.video.map(k => k.label)).toEqual(['口播稿', '分镜', '剪辑建议']);
    expect(SAVE_KINDS.article.map(k => k.kind)).toEqual(['brief']);
    expect(SAVE_KINDS.image_text.map(k => k.kind)).toEqual(['brief']);
    expect(SAVE_KINDS.unknown).toBeUndefined();
    expect([saveStatus('brief'), saveStatus('script'), saveStatus('storyboard'), saveStatus('editing')]).toEqual(['draft', 'final', 'final', 'final']);
  });
  it('says why a storyboard or editing save was refused for want of its source', () => {
    expect(saveRefusal('OPC_CONTENT_SOURCE', 'storyboard')).toContain('先把口播稿存好');
    expect(saveRefusal('OPC_CONTENT_SOURCE', 'editing')).toContain('先把分镜存好');
    expect(saveRefusal('OPC_VERSION_CONFLICT', 'script')).toContain('再点一次');
  });
});
