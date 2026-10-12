/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeWaffoFailure, normalizeWaffoPrivateKey, normalizeWaffoPublicKey, WaffoFailure } from './waffoFailure';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs8 = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pkcs1 = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const spki = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const body = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
const signs = (pem: string) => createVerify('RSA-SHA256').update('x')
  .verify(keys.publicKey, createSign('RSA-SHA256').update('x').sign(pem, 'base64'), 'base64');

describe('Waffo key normalisation (dashboard paste formats)', () => {
  it.each([
    ['multi-line PEM', pkcs8], ['PKCS#1 PEM', pkcs1], ['single line with literal \\n', pkcs8.replace(/\n/g, '\\n')],
    ['CRLF line endings', pkcs8.replace(/\n/g, '\r\n')], ['bare base64 body', body(pkcs8)],
    ['headers on one line separated by spaces', pkcs8.replace(/\n/g, ' ')],
  ])('accepts %s', (_, raw) => { expect(signs(normalizeWaffoPrivateKey(raw))).toBe(true); });
  it('reports an unusable key by shape only, never its content', () => {
    for (const raw of ['', 'not a key', `"${pkcs8.slice(0, 120)}"`, body(spki)]) {
      let failure: unknown;
      try { normalizeWaffoPrivateKey(raw); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(WaffoFailure);
      const logged = describeWaffoFailure(failure);
      expect(logged).toMatchObject({ code: 'PAY_WAFFO_TEST_CONFIG_INVALID', category: 'private_key_invalid' });
      expect(JSON.stringify(logged)).not.toContain(body(pkcs8).slice(64, 96));
    }
    expect(describeWaffoFailure((() => { try { normalizeWaffoPrivateKey(pkcs8.replace(/\n/g, '\\n').slice(0, 300)); }
      catch (error) { return error; } })())).toMatchObject({ keyShape: { hasPemHeader: true, hasLiteralBackslashN: true,
      hasRealNewlines: false } });
  });
  it('normalises webhook public keys the same way and leaves unusable values to fail closed', () => {
    for (const raw of [spki, spki.replace(/\n/g, '\\n'), body(spki)]) {
      expect(createVerify('RSA-SHA256').update('x').verify(normalizeWaffoPublicKey(raw),
        createSign('RSA-SHA256').update('x').sign(pkcs8, 'base64'), 'base64')).toBe(true);
    }
    expect(normalizeWaffoPublicKey('garbage')).toBe('garbage');
  });
  it('summarises response-shape and generic errors without values', () => {
    const shape = z.object({ sessionId: z.string().regex(/^cs_/) }).safeParse({ sessionId: 'secret-looking' });
    expect(describeWaffoFailure(shape.error)).toMatchObject({ code: 'PAY_WAFFO_RESPONSE_SHAPE', category: 'response_shape' });
    expect(JSON.stringify(describeWaffoFailure(shape.error))).not.toContain('secret-looking');
    expect(describeWaffoFailure(new Error('PAY_WAFFO_PRICE_UNAVAILABLE'))).toEqual({ code: 'PAY_WAFFO_PRICE_UNAVAILABLE', errorName: 'Error' });
  });
});
