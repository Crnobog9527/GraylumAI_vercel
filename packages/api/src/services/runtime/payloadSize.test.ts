/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it, expect } from 'vitest';
import { stagingProcedureError } from './stagingErrors';
import { postgresJsonbBytes, assertFrozenPayloads, FROZEN_PAYLOAD_BYTES } from './payloadSize';
it.each([null, true, false, {}, [], { a: '中', b: ['a', 2] }])('matches jsonb separators for %j', value => {
  const pg = JSON.stringify(value).replace(/,(?=(?:[^"\\]*"[^"\\]*")*[^"\\]*$)/g, ', ').replace(/:/g, ': ');
  expect(postgresJsonbBytes(value)).toBe(Buffer.byteLength(pg));
});
it.each([[1e-7, '0.0000001'], [1e21, '1000000000000000000000'], [-1.2e-10, '-0.00000000012']])(
  'expands numeric exponents', (value, pg) => expect(postgresJsonbBytes(value)).toBe(String(pg).length));
it('counts escape sequences and Unicode exactly without expanding punctuation inside strings', () => {
  expect(postgresJsonbBytes({ x: 'a,b:c\n中😀' })).toBe(Buffer.byteLength('{"x": "a,b:c\\n中😀"}'));
  expect(() => postgresJsonbBytes({ x: '\u0000' })).toThrow('RUNTIME_FROZEN_PAYLOAD_INVALID');
  expect(() => postgresJsonbBytes({ x: '\ud800' })).toThrow('RUNTIME_FROZEN_PAYLOAD_INVALID');
});
it.each(['context', 'billing'])('rejects only above the exact SQL boundary, for %s', target => {
  const fits = { x: 'x'.repeat(FROZEN_PAYLOAD_BYTES - 9) };
  const over = { x: fits.x + 'x' };
  expect(postgresJsonbBytes(fits)).toBe(FROZEN_PAYLOAD_BYTES);
  expect(() => assertFrozenPayloads(fits, fits)).not.toThrow();
  expect(() => assertFrozenPayloads(target === 'context' ? over : {}, target === 'billing' ? over : {}))
    .toThrow('RUNTIME_FROZEN_PAYLOAD_TOO_LARGE');
});

it('maps oversized admission to a readable stable public code without exposing input',()=>{
 let cause:unknown;
 try{assertFrozenPayloads({privateInput:'x'.repeat(262144)},{});}catch(error){cause=error;}
 const error=stagingProcedureError(cause,'runtime.prepare');
 expect(error.code).toBe('BAD_REQUEST');expect(error.message).toContain('RUNTIME_FROZEN_PAYLOAD_TOO_LARGE');
 expect(error.message).not.toContain('privateInput');
});
