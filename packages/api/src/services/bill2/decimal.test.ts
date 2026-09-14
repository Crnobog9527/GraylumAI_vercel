/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, it, expect } from 'vitest';
import { aggregateCredits, decimal, parseExactJson } from './decimal';
import { fixtureEvidence, localFixtureAdapter } from './fixtureAdapter';
describe('BILL2 exact arithmetic and evidence', () => {
  it('aggregates once, freezes multiplier and preserves zero', () => {
    expect(aggregateCredits(['0.0004','0.0004'],'1000','1.5')).toBe(2);
    expect(aggregateCredits(['0.0001','0.0001','0.0001'],'1000','1.5')).toBe(1);
    expect(aggregateCredits(['0'],'1000','1.5')).toBe(0);
    const frozen = '1.5'; let current = '2'; expect(aggregateCredits(['0.001'], '1000', frozen)).toBe(2); current = '3';
    expect(aggregateCredits(['0.001'], '1000', frozen)).not.toBe(aggregateCredits(['0.001'], '1000', current));
  });
  it.each(['-1','NaN','Infinity','1e-3','01','1.0000000000001','1000000000000','',null,0.1])('rejects invalid/overprecision amount %s', (v) => expect(() => decimal(v)).toThrow());
  it('rejects integer overflow and zero rules', () => {
    expect(() => aggregateCredits(['2147483648'],'1','1')).toThrow('OVERFLOW');
    expect(() => aggregateCredits(['0'],'0','1')).toThrow('RULES');
  });
  it('never routes unquoted decimals or large integers through Number', () => {
    expect(parseExactJson('{"cost":0.123456789012,"id":9007199254740993,"nested":[0.000000000001,true,null,"a\\\"b"]}')).toEqual({cost:'0.123456789012',id:'9007199254740993',nested:['0.000000000001',true,null,'a"b']});
  });
  it.each(['{"cost":1,"cost":2}','{"a":1,}','[1,]','NaN','{"a":01}','true false'])('rejects invalid or duplicate evidence %s',raw=>expect(()=>parseExactJson(raw)).toThrow());
  it('Fusion total excludes included children and raw evidence remains private', () => {
    const raw='{"id":"fusion-1","model":"fusion","final":true,"cost":0.0008,"currency":"USD","coverage":"request_total","includedDetails":[{"cost":0.0003,"currency":"USD"},{"cost":0.0004,"currency":"USD"}]}';
    const e=fixtureEvidence(raw,{provider:'fixture',account:'a',model:'fusion',protocol:'fixture-cost-v1'},'response');
    expect(e.cost).toBe('0.0008');expect(e.includedDetails).toHaveLength(2);expect(e.rawBody).toBe(raw);
    expect(aggregateCredits([e.cost!],'1000','1')).toBe(1);
  });
  it('only a final explicit zero is zero; missing cost stays null', () => {
    const identity={provider:'fixture',account:'a',model:'m',protocol:'fixture-cost-v1' as const};
    expect(fixtureEvidence('{"id":"x","model":"m","final":false,"cost":null,"currency":"USD","coverage":"request_total"}',identity,'lookup').cost).toBeNull();
    expect(fixtureEvidence('{"id":"x","model":"m","final":true,"cost":0,"currency":"USD","coverage":"request_total"}',identity,'lookup').cost).toBe('0');
  });
  it.each(['https://api.openrouter.ai','http://localhost.evil.test','http://example.com','http://user:password@127.0.0.1'])('refuses real or ambiguous provider %s',u=>expect(()=>localFixtureAdapter(u)).toThrow('DISABLED'));
});
