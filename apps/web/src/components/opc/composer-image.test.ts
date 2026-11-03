/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { prepareChatImages, restoredImages } from './composer-image';
import type { ChatImage } from '@/lib/chat-image';

const file = (name: string) => new File([new Uint8Array([1])], name, { type: 'image/png' });
function harness() {
  const attached: ChatImage[] = [], refused: string[] = [];
  let pending = 0;
  const waiting = new Map<string, (image: ChatImage) => void>();
  const deps = {
    held: () => attached.length + pending,
    pending: (change: 1 | -1) => { pending += change; },
    attach: (image: ChatImage) => { attached.push(image); },
    refuse: (message: string) => { refused.push(message); },
    make: (f: File) => new Promise<ChatImage>(done => waiting.set(f.name, done)),
  };
  const finish = async (name: string) => { waiting.get(name)!({ id: name, name, url: 'data:image/jpeg;base64,AA==' }); await new Promise(r => setTimeout(r, 0)); };
  return { deps, attached, refused, finish, pending: () => pending };
}

// Review on #1702: a drop while a paste is still being prepared must keep sending blocked until both are done.
it('keeps sending blocked until every overlapping add has finished', async () => {
  const h = harness();
  const paste = prepareChatImages([file('pasted')], h.deps), drop = prepareChatImages([file('dropped')], h.deps);
  expect(h.pending()).toBe(2);
  await h.finish('dropped');
  expect(h.pending(), 'one image is still being prepared').toBe(1);
  await h.finish('pasted');
  await Promise.all([paste, drop]);
  expect(h.pending()).toBe(0);
  expect(h.attached.map(image => image.name).sort()).toEqual(['dropped', 'pasted']);
});

it('counts images still being prepared against the four-image limit, and ignores files that are not images', async () => {
  const h = harness();
  const first = prepareChatImages([file('a'), file('b'), file('c')], h.deps);
  const second = prepareChatImages([file('d'), file('e'), new File(['x'], 'notes.txt', { type: 'text/plain' })], h.deps);
  expect(h.pending()).toBe(4);
  expect(h.refused).toEqual(['一条消息最多附 4 张图片，多出的没有加入。']);
  for (const name of ['a', 'b', 'c', 'd']) await h.finish(name);
  await Promise.all([first, second]);
  expect(h.attached).toHaveLength(4);
  expect(h.pending()).toBe(0);
});

// Review on #1702: a refused send gives its images back without dropping those added while it was being sent.
it('gives a refused message its images back ahead of those added meanwhile, at most four', () => {
  const image = (id: string) => ({ id, name: id, url: 'data:image/jpeg;base64,AA==' });
  expect(restoredImages([image('a'), image('b')], [image('new')])).toEqual({ images: [image('a'), image('b'), image('new')], dropped: 0 });
  expect(restoredImages([image('a'), image('b'), image('c')], [image('x'), image('y')]))
    .toEqual({ images: [image('a'), image('b'), image('c'), image('x')], dropped: 1 });
  expect(restoredImages([], [image('new')])).toEqual({ images: [image('new')], dropped: 0 });
});
