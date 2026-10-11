/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { isSignedStorageUrl } from './signed-url';

const base = 'https://proj.supabase.co';
it('accepts only signed storage URLs on the configured project', () => {
  expect(isSignedStorageUrl(base + '/storage/v1/object/sign/library-documents/u/d/original?token=t', 'read', base)).toBe(true);
  expect(isSignedStorageUrl(base + '/storage/v1/object/upload/sign/library-documents/u/d/original?token=t', 'upload', base))
    .toBe(true);
  expect(isSignedStorageUrl(base + '/storage/v1/object/upload/sign/x?token=t', 'read', base)).toBe(false);
  expect(isSignedStorageUrl('https://evil.example/storage/v1/object/sign/x?token=t', 'read', base)).toBe(false);
  expect(isSignedStorageUrl('javascript:alert(1)', 'read', base)).toBe(false);
  expect(isSignedStorageUrl(base + '/storage/v1/object/sign/x', 'read', base)).toBe(false);
  expect(isSignedStorageUrl('http://proj.supabase.co/storage/v1/object/sign/x?token=t', 'read', base)).toBe(false);
  expect(isSignedStorageUrl(base + '/storage/v1/object/sign/x?token=t', 'read', undefined)).toBe(false);
});
