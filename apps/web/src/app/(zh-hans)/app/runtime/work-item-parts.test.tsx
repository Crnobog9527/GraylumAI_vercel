/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkSaveActions } from './work-item-parts';
import { SAVE_KINDS } from './work-turn-path';

// CONTENT-CONVERSATION-2: under a reply of a video topic, one button per kind; a kind saved from this reply shows its version instead.
it('offers script, storyboard and editing for a video reply, and shows what this reply was saved as', () => {
  const fresh = renderToStaticMarkup(<WorkSaveActions kinds={SAVE_KINDS.video} saved={{}} href="/lib" disabled={false} onSave={() => undefined} />);
  for (const label of ['存为口播稿', '存为分镜', '存为剪辑建议']) expect(fresh).toContain(label);
  const saved = renderToStaticMarkup(<WorkSaveActions kinds={SAVE_KINDS.video} saved={{ script: 2 }} href="/lib" disabled={false} onSave={() => undefined} />);
  expect(saved).toContain('已存为口播稿 · 第 2 版');
  expect(saved).not.toContain('存为口播稿</button>');
  expect(saved).toContain('存为分镜');
  const article = renderToStaticMarkup(<WorkSaveActions kinds={SAVE_KINDS.article} saved={{}} href="/lib" disabled={false} onSave={() => undefined} />);
  expect(article).toContain('存为正文');
  expect(article).not.toContain('口播稿');
});
