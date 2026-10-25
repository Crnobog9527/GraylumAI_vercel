/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect, it, vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {readAdmissionConfiguration} from './admissionConfiguration';
import {rowFor, rowsFor, type ConfigurationRows} from './settingsRows';
import {admitLibraryRetrieval, LIBRARY_AGENT_READ_KEY, LIBRARY_RETRIEVAL_KEY} from './libraryAdmission';
import {admitOwnPosts, OWN_POSTS_SWITCH} from './workspacePosts';
import {chatResearchEnabled, CHAT_RESEARCH_KEY} from './freeChatResearch';
import {readBillingUnitSettings, readMultiplierSnapshot, BILLING_UNIT_SETTING_KEYS} from '../billingUnit';
import {readProviderPrices, PROVIDER_PRICES_KEY} from '../billingProviderPrices';
import {readResearchToolsConfig} from '../research/vendors/config';
import {readPricingStates} from './pricingAdmission';

/*
 * DB-PERF PR-3: a new admission reads every setting it uses in one query and each reader takes those rows; without
 * them a reader queries as before (execution, the per-call gate and every other caller stay fresh).
 */
const noDatabase = () => ({from: vi.fn(() => { throw new Error('no query expected'); })}) as unknown as SupabaseClient;
const rows = (data: ConfigurationRows['data'], error: unknown = null) => Promise.resolve({data, error});

it('reads every admission setting, with its text for the provider prices hash, in one query', async () => {
  const keys: string[][] = [];
  const select = vi.fn(() => ({in: async (_column: string, list: string[]) => { keys.push(list); return {data: [], error: null}; }}));
  const admin = {from: vi.fn(() => ({select}))} as unknown as SupabaseClient;
  await readAdmissionConfiguration(admin);
  expect(admin.from).toHaveBeenCalledTimes(1);
  expect(select).toHaveBeenCalledWith('key,value,raw:value::text');
  for (const key of [LIBRARY_AGENT_READ_KEY, LIBRARY_RETRIEVAL_KEY, OWN_POSTS_SWITCH, 'publish_monitor_enabled', 'runtime_payg_staging',
    'runtime_payg_production', BILLING_UNIT_SETTING_KEYS.creditsPerUsd, BILLING_UNIT_SETTING_KEYS.multiplier, CHAT_RESEARCH_KEY,
    'billing_payg_start_thresholds', PROVIDER_PRICES_KEY, 'research_tools_config', 'primary_model_id', 'v3_summary_model_id'])
    expect(keys[0]).toContain(key);
});

it('gives each reader exactly what its own query returned: matching rows, null when missing, the error when failed', () => {
  const data = [{key: 'a', value: 1}, {key: 'b', value: true}];
  expect(rowsFor({data, error: null}, ['b', 'c'])).toEqual({data: [{key: 'b', value: true}], error: null});
  expect(rowFor({data, error: null}, 'a')).toEqual({data: {key: 'a', value: 1}, error: null});
  expect(rowFor({data, error: null}, 'c')).toEqual({data: null, error: null});
  const failure = {code: '57014'};
  expect(rowsFor({data: null, error: failure}, ['a'])).toEqual({data: null, error: failure});
  expect(rowFor({data: null, error: failure}, 'a')).toEqual({data: null, error: failure});
});

it('readers use the admission rows without querying, and refuse the same way when the one read failed', async () => {
  const on = rows([{key: LIBRARY_AGENT_READ_KEY, value: true}, {key: LIBRARY_RETRIEVAL_KEY, value: 'true'},
    {key: OWN_POSTS_SWITCH, value: true}, {key: 'publish_monitor_enabled', value: true}, {key: CHAT_RESEARCH_KEY, value: true},
    {key: BILLING_UNIT_SETTING_KEYS.creditsPerUsd, value: '100'}, {key: BILLING_UNIT_SETTING_KEYS.multiplier, value: '6'}]);
  const db = noDatabase();
  expect(await admitLibraryRetrieval(db, true, 'ordinary', [], on)).toBe(true);
  expect(await admitOwnPosts(db, true, 'ordinary', [], on)).toBe(true);
  expect(await chatResearchEnabled(db, on)).toBe(true);
  expect(await readBillingUnitSettings(db, on)).toMatchObject({creditsPerUsd: '100', defaultMultiplier: '6'});
  const failed = rows(null, {code: '57014'});
  await expect(admitLibraryRetrieval(db, true, 'ordinary', [], failed)).rejects.toThrow();
  await expect(admitOwnPosts(db, true, 'ordinary', [], failed)).rejects.toThrow('RUNTIME_WORKSPACE_UNAVAILABLE');
  await expect(readBillingUnitSettings(db, failed)).rejects.toMatchObject({code: 'BILLING_UNIT_SETTINGS_UNAVAILABLE'});
  await expect(readProviderPrices(db, failed)).rejects.toMatchObject({code: 'BILLING_UNIT_PROVIDER_PRICES_UNAVAILABLE'});
  expect((await readResearchToolsConfig(db, failed)).source).toBe('invalid');
});

it('the research config keeps its stored revision as PostgreSQL ->> would give it', async () => {
  const stored = await readResearchToolsConfig(noDatabase(), rows([{key: 'research_tools_config', value: {revision: 7, broken: true}}]));
  // An invalid stored value still reports its revision, so an administrator can overwrite it.
  expect(stored).toMatchObject({source: 'invalid', revision: 7});
  expect((await readResearchToolsConfig(noDatabase(), rows([]))).source).toBe('default');
});

it('the provider prices hash uses the same stored text as its own query', async () => {
  const value = {version: 1, entries: []};
  const raw = '{"entries": [], "version": 1}';
  const fromRows = await readProviderPrices(noDatabase(), rows([{key: PROVIDER_PRICES_KEY, value, raw}]));
  const maybeSingle = async () => ({data: {value, raw}, error: null});
  const db = {from: () => ({select: () => ({eq: () => ({maybeSingle})})})} as unknown as SupabaseClient;
  expect(fromRows).toEqual(await readProviderPrices(db));
});

it('reuses a model row only when it holds every column the reader needs; otherwise it reads the model', async () => {
  const query = vi.fn(async () => ({data: [{id: 'm', price_multiplier: '2'}], error: null}));
  const db = {from: vi.fn(() => ({select: () => ({in: query})}))} as unknown as SupabaseClient;
  const settings = rows([{key: BILLING_UNIT_SETTING_KEYS.creditsPerUsd, value: '100'}, {key: BILLING_UNIT_SETTING_KEYS.multiplier, value: '6'}]);
  const withColumn = await readMultiplierSnapshot(db, ['m'], undefined, {configuration: settings, models: [{id: 'm', price_multiplier: '2'}]});
  expect(query).not.toHaveBeenCalled();
  const withoutColumn = await readMultiplierSnapshot(db, ['m'], undefined, {configuration: settings, models: [{id: 'm'}]});
  expect(query).toHaveBeenCalledTimes(1);
  expect(withColumn).toEqual(withoutColumn);
  // Pricing needs updated_at too: a row without it is read again.
  const pricing = vi.fn(async () => ({data: [], error: null}));
  const pricingDb = {from: () => ({select: () => ({in: pricing})})} as unknown as SupabaseClient;
  await expect(readPricingStates(pricingDb, [{modelId: 'm', model: 'x'}], {}, true, [{id: 'm', model_id: 'x', config: {}}]))
    .rejects.toThrow();
  expect(pricing).toHaveBeenCalledTimes(1);
});
