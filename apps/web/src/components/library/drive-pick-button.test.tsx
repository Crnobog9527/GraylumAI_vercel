/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DrivePickButton } from './drive-pick-button';

describe('「从 Google 云端硬盘选择」 (VOICE-2 PR-7)', () => {
  it('is not shown until all three Google settings exist', () => {
    expect(renderToStaticMarkup(<DrivePickButton disabled={false} onFiles={() => undefined} config={null} />)).toBe('');
  });
  it('is shown with them, and waits for a purpose like the upload button', () => {
    const config = { apiKey: 'k', clientId: 'c', appId: '1' };
    expect(renderToStaticMarkup(<DrivePickButton disabled={false} onFiles={() => undefined} config={config} />)).toContain('从 Google 云端硬盘选择');
    expect(renderToStaticMarkup(<DrivePickButton disabled onFiles={() => undefined} config={config} />)).toContain('disabled=""');
  });
});
