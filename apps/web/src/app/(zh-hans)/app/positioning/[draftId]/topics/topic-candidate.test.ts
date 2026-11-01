/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { parseAdoption, parseCandidate, topicAdoptionNotice } from './topic-candidate';

const id = '3f1c2a54-7b0e-4d1a-9a52-1c6e8d0b7a11';
const item = { id, platform: 'tiktok', account: 'prep-ahead-baby-meals', title: 'One hour', brief: 'Why', day: '2026-11-02', contentType: 'video' };
const block = (value: unknown) => 'Text\n```json\n' + JSON.stringify(value) + '\n```';
const adopt = block({ action: 'adopt', itemIds: [id] });

describe('topic candidates and adoption in a reply', () => {
  it('reads a block in the stated format', () => {
    expect(parseCandidate(block([item]))?.[0]?.id).toBe(id);
    expect(parseAdoption(adopt)).toEqual([id]);
  });
  it('turns 60 and 61 on staging: a weekday, a display name and a capitalised platform are no candidate, and the page says so', () => {
    expect(parseCandidate(block([{ ...item, platform: 'TikTok', account: 'Prep Ahead（拟用名称）', day: '周四' }]))).toBeNull();
    expect(topicAdoptionNotice({ input: '请采用第一条', body: adopt }, null, new Set())).toContain('没有采用');
  });
  it('says nothing unasked: no action, already adopted, or an adoption the page carries out', () => {
    const shown = [{ id, title: 'One hour' }];
    expect(topicAdoptionNotice({ input: '好', body: 'plain' }, shown, new Set())).toBeNull();
    expect(topicAdoptionNotice({ input: '采用第一条', body: adopt }, shown, new Set([id]))).toBeNull();
    expect(topicAdoptionNotice({ input: '采用第一条', body: adopt }, shown, new Set())).toBeNull();
    expect(topicAdoptionNotice(undefined, shown, new Set())).toBeNull();
  });
  it('a reply that adopts without the user saying so is refused, out loud', () => {
    expect(topicAdoptionNotice({ input: '好，继续', body: adopt }, [{ id, title: 'One hour' }], new Set())).toContain('没有采用');
  });
});
