/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {ADMIT_STALE, admitInTwoSteps, admitStale} from './admitSplit';
import {readRwV2, RW_V2_KEY} from './rwV2';

const args = {p_session_id: 's', p_request_id: 'r', p_payload: {a: 1}, p_billing: {b: 2}};
const stale = () => new Error('RUNTIME_ADMISSION_DENIED', {cause: new Error(ADMIT_STALE)});

describe('admitInTwoSteps', () => {
  it('proves, then commits with the proof', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const result = await admitInTwoSteps(async (name, a) => {
      calls.push([name, a]);
      return name === 'runtime_admit_precheck' ? {version: 1, binding: 'x'} : {executionId: 'e'};
    }, args);
    expect(result).toEqual({executionId: 'e'});
    expect(calls.map(c => c[0])).toEqual(['runtime_admit_precheck', 'runtime_admit_commit']);
    expect(calls[1]![1]).toEqual({...args, p_pre: {version: 1, binding: 'x'}});
  });
  it('returns the replay of an already admitted request without a commit', async () => {
    const names: string[] = [];
    const result = await admitInTwoSteps(async name => { names.push(name); return {replay: {executionId: 'old'}}; }, args);
    expect(result).toEqual({executionId: 'old'});
    expect(names).toEqual(['runtime_admit_precheck']);
  });
  it('asks once more with a fresh proof when the commit finds the proof stale', async () => {
    let commits = 0;
    const result = await admitInTwoSteps(async name => {
      if (name === 'runtime_admit_precheck') return {version: 1, n: commits};
      if (commits++ === 0) throw stale();
      return {executionId: 'e2'};
    }, args);
    expect(result).toEqual({executionId: 'e2'});
    expect(commits).toBe(2);
  });
  it('does not retry a second stale commit and does not retry any other refusal', async () => {
    let commits = 0;
    await expect(admitInTwoSteps(async name => { if (name === 'runtime_admit_commit') { commits++; throw stale(); } return {}; }, args))
      .rejects.toThrow('RUNTIME_ADMISSION_DENIED');
    expect(commits).toBe(2);
    commits = 0;
    await expect(admitInTwoSteps(async name => { if (name === 'runtime_admit_commit') { commits++; throw new Error('RUNTIME_SESSION_BUSY'); } return {}; }, args))
      .rejects.toThrow('RUNTIME_SESSION_BUSY');
    expect(commits).toBe(1);
    expect(admitStale(new Error('RUNTIME_ADMISSION_DENIED'))).toBe(false);
  });
  it('lets a refusal of the precheck through untouched', async () => {
    await expect(admitInTwoSteps(async () => { throw new Error('OPC_ANSWER_SOURCE_DENIED'); }, args)).rejects.toThrow('OPC_ANSWER_SOURCE_DENIED');
  });
});

describe('readRwV2', () => {
  const rows = (value: unknown, error: unknown = null) => ({data: value === undefined ? [] : [{key: RW_V2_KEY, value}], error});
  it('is off unless the setting says true for the step', () => {
    expect(readRwV2(rows({admitSplit: true}))).toEqual({admitSplit: true});
    for (const value of [undefined, null, {}, {admitSplit: 'true'}, {admitSplit: 1}, {admitSplit: false}, [], 'on'])
      expect(readRwV2(rows(value))).toEqual({admitSplit: false});
    expect(readRwV2({data: null, error: new Error('down')})).toEqual({admitSplit: false});
  });
});
