/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callBillingUnit } from './billingUnitAdmission';

// The per-call multiplier is written by TS and read by three SQL places in 0157; one path for all.
const sql = readFileSync(new URL('../../../../db/migrations/0157_bill_unit.sql', import.meta.url), 'utf8');

describe('per-call billingUnit payload path', () => {
  it('TS writes payload.billingUnit.{modelId,multiplier,source}', () => {
    const rules = { billingUnit: { version: 'bill-unit-v2' as const, creditsPerUsd: '100', defaultMultiplier: '3',
      models: { m: { multiplier: '2', source: 'model' as const } }, providers: {}, hash: 'f'.repeat(64) } };
    expect(callBillingUnit(rules, { modelId: 'm', multiplier: '2' })).toEqual({ billingUnit: { modelId: 'm', multiplier: '2', source: 'model' } });
  });

  it('0157 reads exactly those keys in claim, finalize and the report', () => {
    expect(sql).toContain("p_payload->'billingUnit'->'multiplier'");
    expect(sql).toContain("p_payload->'billingUnit'->>'modelId'");
    expect(sql.match(/payload->'billingUnit'->'multiplier'/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sql).toContain("c.payload #>> '{billingUnit,multiplier}'");
    expect(sql).toContain("c.payload #>> '{billingUnit,source}'");
    expect(sql).toContain("jsonb_typeof(r.payload->'rules'->'billingUnit')='object'");
    expect(sql).toContain("policy->'multiplier'=p_payload->'billingUnit'->'multiplier'");
  });
});
