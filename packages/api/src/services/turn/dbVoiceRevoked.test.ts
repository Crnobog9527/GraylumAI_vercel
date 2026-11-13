/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { erasedCode, voiceRevokedOnly } from './db';

/* VOICE-ABORT-FIX: an erased close caused only by a deleted writing voice kept the user's message (0529) and is worded as such;
 * a deleted conversation or an erasing account still wins, and an unreadable answer is never taken for a revoked voice. */
describe('erased close: deleted voice or deleted conversation', () => {
  const quiet = { sessionTombstoned: false, accountErasing: false, voiceSourceRevoked: false };
  it('a revoked voice alone is TURN_VOICE_REVOKED', () => {
    expect(voiceRevokedOnly({ ...quiet, voiceSourceRevoked: true })).toBe(true);
    expect(erasedCode({ ...quiet, voiceSourceRevoked: true })).toBe('TURN_VOICE_REVOKED');
  });
  it.each([{ sessionTombstoned: true }, { accountErasing: true }])('%o with a revoked voice is still TURN_TOMBSTONED', extra => {
    expect(erasedCode({ ...quiet, voiceSourceRevoked: true, ...extra })).toBe('TURN_TOMBSTONED');
  });
  it('no tombstones, or none read back (a failed close), is TURN_TOMBSTONED', () => {
    expect(erasedCode(quiet)).toBe('TURN_TOMBSTONED');
    expect(erasedCode(undefined)).toBe('TURN_TOMBSTONED');
    expect(voiceRevokedOnly(null)).toBe(false);
  });
});
