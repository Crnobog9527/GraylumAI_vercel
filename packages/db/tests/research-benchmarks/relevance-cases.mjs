/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE topic relevance (0351 on 0282): the user's benchmark table returns the relevance benchmark_fetch
// stored in each row's own fetch evidence (0–1, anything else NULL) and lists qualified, more relevant rows first.
// A label only: qualification and the report's frozen table are unchanged. Synthetic fixtures only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

export async function relevanceCases({db,check,rpc,seed,answer,fetchAccount,imitable}) {
  await check('RELEVANCE the user table carries each row\'s relevance and orders qualified rows by it', async () => {
    const f = await seed(db), e = await answer(db,f), tag = randomUUID().slice(0,6);
    const withRelevance = value => evidence => ({...evidence,relevance:{value,matched:1,analyzed:2,level:'medium'}});
    await fetchAccount(f,e,`low-${tag}`,{...imitable,tamper:withRelevance(0.1)});
    await fetchAccount(f,e,`high-${tag}`,{...imitable,tamper:withRelevance(0.9)});
    await fetchAccount(f,e,`none-${tag}`,imitable);
    await fetchAccount(f,e,`bad-${tag}`,{...imitable,tamper:withRelevance(2)});
    const rows = await rpc(db,'research_user_benchmarks',f.actor,f.session);
    assert.deepEqual(rows.map(r=>[r.account.split('-')[0],r.topicRelevance]),
      [['high',0.9],['low',0.1],...rows.slice(2).map(r=>[r.account.split('-')[0],null])]);
    assert.deepEqual(new Set(rows.slice(2).map(r=>r.account.split('-')[0])),new Set(['none','bad']));
    assert.ok(rows.every(r=>r.qualified));
    // The report's frozen table never carries it.
    const frozen = await rpc(db,'research_benchmark_rows',f.actor,f.session);
    assert.ok(JSON.stringify(frozen).indexOf('topicRelevance')===-1);
  });

  await check('RELEVANCE the migration is repeatable', async () => {
    const migration = readFileSync(new URL('../../migrations/0351_research_topic_relevance.sql',import.meta.url),'utf8');
    const definition = async () => (await db.query(
      "SELECT pg_get_functiondef('public.research_user_benchmarks(uuid,uuid)'::regprocedure) d")).rows[0].d;
    const before = await definition();
    await db.query(migration);
    assert.equal(await definition(),before);
    assert.ok(before.includes("'topicRelevance'"));
  });
}
