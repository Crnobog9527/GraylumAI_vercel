/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { readSessionUserIdSync } from './session-user';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const b64 = (text: string) => Buffer.from(text).toString('base64url');
const cookieValue = (sub: string) => encodeURIComponent(JSON.stringify({ access_token: `h.${b64(JSON.stringify({ sub }))}.s` }));

it('reads the signed-in user from the session cookie, plain, base64 or split in chunks', () => {
  expect(readSessionUserIdSync(`a=1; sb-x-auth-token=${cookieValue(USER)}`)).toBe(USER);
  expect(readSessionUserIdSync(`sb-x-auth-token=base64-${b64(JSON.stringify({ access_token: `h.${b64(JSON.stringify({ sub: USER }))}.s` }))}`)).toBe(USER);
  const value = cookieValue(USER);
  expect(readSessionUserIdSync(`sb-x-auth-token.1=${value.slice(10)}; sb-x-auth-token.0=${value.slice(0, 10)}`)).toBe(USER);
});

it('knows nobody when nothing is readable, or two users are signed in', () => {
  expect(readSessionUserIdSync('')).toBeNull();
  expect(readSessionUserIdSync('sb-x-auth-token=garbage')).toBeNull();
  expect(readSessionUserIdSync(`sb-x-auth-token=${cookieValue('not-a-uuid')}`)).toBeNull();
  expect(readSessionUserIdSync(`sb-x-auth-token=${cookieValue(USER)}; sb-y-auth-token=${cookieValue(OTHER)}`)).toBeNull();
});
