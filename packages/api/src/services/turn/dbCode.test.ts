/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { CREDIT_ACCOUNT_REVIEW, turnDatabaseCode } from './db';

it('keeps a turn code, names a refused freeze for what it is, and hides everything else behind unavailable', () => {
  expect(turnDatabaseCode('TURN_SESSION_BUSY')).toBe('TURN_SESSION_BUSY');
  expect(turnDatabaseCode('PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS: 2')).toBe(CREDIT_ACCOUNT_REVIEW);
  expect(turnDatabaseCode('PRE_DEDUCT_SUBSCRIPTION_MIRROR_MISSING')).toBe(CREDIT_ACCOUNT_REVIEW);
  expect(turnDatabaseCode('relation "x" does not exist')).toBe('TURN_DATABASE_UNAVAILABLE');
  expect(turnDatabaseCode(undefined)).toBe('TURN_DATABASE_UNAVAILABLE');
  // A caller's own list of known codes still decides first.
  expect(turnDatabaseCode('FUSION_REVIEW_ACTIVE', /\b(FUSION_[A-Z_]+)\b/)).toBe('FUSION_REVIEW_ACTIVE');
});
