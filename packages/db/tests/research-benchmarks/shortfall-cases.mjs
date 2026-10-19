/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-SHORTFALL (0320, Owner 2026-10-20 choice B): a positioning report with 1 to required-1 qualified
// benchmarks only after 2 completed searches and the user's frozen "generate" choice. Synthetic fixtures only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function shortfallCases({db,check,rpc,seed,answer,erase,fetchAccount,imitable,gate}) {
  /** One search round: a keyword card the user confirmed and its discovery, completed unless `running`. */
  async function round(f,e,state='completed') {
    const card = randomUUID(), tag = card.slice(0,6);
    await rpc(db,'research_card_create',f.actor,card,f.session,e,{kind:'keywords',
      options:[{id:'k0',text:`钩针 ${tag}`},{id:'k1',text:`玩偶 ${tag}`},{id:'k2',text:`手作 ${tag}`}]});
    const confirmed = await rpc(db,'research_card_confirm',f.actor,card,{selected:['k0','k1','k2']});
    const d = await rpc(db,'research_discovery_start',f.actor,f.session,e,confirmed.confirmationId,['tiktok']);
    if (state==='completed') await rpc(db,'research_discovery_save',f.actor,f.session,d.discoveryId,{},'completed');
    return d.discoveryId;
  }
  const offer = (f,e,card=randomUUID()) => rpc(db,'research_benchmark_shortfall_offer',f.actor,f.session,e,card);
  const choose = (f,card,choice) => rpc(db,'research_benchmark_shortfall_choose',f.actor,card,choice);
  const state = f => rpc(db,'research_user_shortfall',f.actor,f.session);
  const refused = promise => assert.rejects(promise,/REPORT_BENCHMARKS_REQUIRED/);
  /** A session with `n` qualified accounts fetched by its own answer. */
  async function session(n) {
    const f = await seed(db), e = await answer(db,f);
    for (let i = 0; i < n; i++) await fetchAccount(f,e,`q${i}-${randomUUID().slice(0,6)}`,imitable);
    return {f,e};
  }

  await check('SHORTFALL fewer than 3 and fewer than 2 completed rounds: refused, no card', async () => {
    const {f,e} = await session(2);
    await refused(gate(f));
    await assert.rejects(offer(f,e),/RESEARCH_SHORTFALL_NOT_DUE/,'no round yet');
    await round(f,e);
    await round(f,e,'running');
    assert.deepEqual(await state(f),{rounds:1,qualified:2,card:null},'a running discovery is not a round');
    await assert.rejects(offer(f,e),/RESEARCH_SHORTFALL_NOT_DUE/,'one completed round');
    await refused(gate(f));
  });

  await check('SHORTFALL 2 rounds but no choice: refused; the card is offered once', async () => {
    const {f,e} = await session(2);
    await round(f,e);await round(f,e);
    await refused(gate(f));
    const card = await offer(f,e);
    assert.deepEqual([card.required,card.offeredQualified,card.offeredRounds,card.choice],[3,2,2,null]);
    // The open card is returned again for another call, never a second card.
    assert.equal((await offer(f,e)).cardId,card.cardId);
    await refused(gate(f));
    await assert.rejects(choose(f,card.cardId,'maybe'),/RESEARCH_CARD_INVALID/);
    const other = await seed(db);
    await assert.rejects(rpc(db,'research_benchmark_shortfall_choose',other.actor,card.cardId,'generate'),/RESEARCH_SCOPE_DENIED/);
  });

  await check('SHORTFALL "generate" with 1 or 2 qualified: admitted; the choice is frozen', async () => {
    for (const n of [1,2]) {
      const {f,e} = await session(n);
      await round(f,e);await round(f,e);
      const card = await offer(f,e);
      const chosen = await choose(f,card.cardId,'generate');
      assert.deepEqual([chosen.choice,chosen.chosenQualified,chosen.chosenRounds],['generate',n,2]);
      await gate(f);
      // Frozen: more qualified accounts and more rounds later never rewrite who chose, when, or the count then.
      await fetchAccount(f,await answer(db,f),`late-${n}`,imitable);
      await round(f,e);
      const after = (await state(f)).card;
      assert.deepEqual([after.choice,after.chosenQualified,after.chosenRounds,after.chosenAt,after.confirmationId],
        [chosen.choice,n,2,chosen.chosenAt,chosen.confirmationId]);
      assert.deepEqual(await choose(f,card.cardId,'generate'),after,'the same answer again returns the stored record');
      await assert.rejects(choose(f,card.cardId,'continue'),/RESEARCH_CARD_ALREADY_CONFIRMED/);
      assert.equal((await offer(f,e)).cardId,card.cardId,'no new card after "generate"');
      await gate(f);
    }
  });

  await check('SHORTFALL a workflow requiring more than 3 is never bypassed by the 3-account card', async () => {
    const f = await seed(db,'complete',0,{minQualifiedBenchmarks:5}), e = await answer(db,f);
    for (const account of ['m1','m2']) await fetchAccount(f,e,`${account}-${randomUUID().slice(0,6)}`,imitable);
    await round(f,e);await round(f,e);
    const card = await offer(f,e);
    assert.equal(card.required,3);
    await choose(f,card.cardId,'generate');
    await refused(gate(f));
  });

  await check('SHORTFALL 0 qualified is refused even with a "generate" choice', async () => {
    const f = await seed(db), fetcher = await answer(db,f), e = await answer(db,f);
    await fetchAccount(f,fetcher,'only',imitable);
    await round(f,e);await round(f,e);
    const card = await offer(f,e);
    await choose(f,card.cardId,'generate');
    await gate(f);
    await erase(db,f,'answer',fetcher);
    assert.equal((await state(f)).qualified,0);
    assert.equal((await state(f)).card.chosenQualified,1,'the frozen count stays');
    await refused(gate(f));
    // And a session that never had one cannot even get the card.
    const {f:g,e:ge} = await session(0);
    await round(g,ge);await round(g,ge);
    await assert.rejects(offer(g,ge),/RESEARCH_SHORTFALL_NOT_DUE/);
  });

  await check('SHORTFALL a stale open card cannot record "generate" once the conditions no longer hold', async () => {
    const f = await seed(db), fetcher = await answer(db,f), e = await answer(db,f);
    await fetchAccount(f,fetcher,`stale-${randomUUID().slice(0,6)}`,imitable);
    await round(f,e);await round(f,e);
    const card = await offer(f,e);
    await erase(db,f,'answer',fetcher);
    await assert.rejects(choose(f,card.cardId,'generate'),/RESEARCH_SHORTFALL_NOT_DUE/);
    assert.equal((await state(f)).card.choice,null,'the card stays open');
    // Restored later: the user chooses again with the conditions holding together.
    await fetchAccount(f,await answer(db,f),`back-${randomUUID().slice(0,6)}`,imitable);
    await refused(gate(f));
    assert.equal((await choose(f,card.cardId,'generate')).chosenQualified,1);
    await gate(f);
  });

  await check('SHORTFALL "continue": refused; a new card only after another completed round', async () => {
    const {f,e} = await session(2);
    await round(f,e);await round(f,e);
    const first = await offer(f,e);
    await choose(f,first.cardId,'continue');
    await refused(gate(f));
    await assert.rejects(offer(f,e),/RESEARCH_SHORTFALL_NOT_DUE/);
    await round(f,e);
    const second = await offer(f,e);
    assert.notEqual(second.cardId,first.cardId);
    assert.equal(second.offeredRounds,3);
    await choose(f,second.cardId,'generate');
    await gate(f);
  });

  await check('SHORTFALL 3 or more qualified: admitted as before, no card', async () => {
    const {f,e} = await session(3);
    await gate(f);
    await round(f,e);await round(f,e);
    await assert.rejects(offer(f,e),/RESEARCH_SHORTFALL_NOT_DUE/);
    assert.equal((await state(f)).card,null);
  });

  await check('SHORTFALL deleting the answer with the choice, or the conversation, removes it', async () => {
    const {f,e} = await session(2);
    const asker = await answer(db,f);
    await round(f,e);await round(f,e);
    const card = await offer(f,asker);
    await choose(f,card.cardId,'generate');
    await gate(f);
    await erase(db,f,'answer',asker);
    assert.equal((await db.query('SELECT count(*)::int n FROM research_benchmark_shortfalls WHERE id=$1',[card.cardId])).rows[0].n,0);
    await refused(gate(f));
    const again = await offer(f,e);
    await choose(f,again.cardId,'generate');
    await erase(db,f,'session',f.session);
    assert.equal((await db.query('SELECT count(*)::int n FROM research_benchmark_shortfalls WHERE session_id=$1',[f.session])).rows[0].n,0);
    // Account erasure deletes the actor's cards too (same place as 0268's benchmark rows).
    const definition = (await db.query(
      "SELECT pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure) d")).rows[0].d;
    assert.match(definition,/DELETE FROM research_benchmark_shortfalls WHERE actor_id=p_profile_id;/);
  });

  await check('SHORTFALL tables and functions are closed to client roles', async () => {
    for (const role of ['anon','authenticated']) {
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(db.query('SELECT research_user_shortfall($1,$2)',[randomUUID(),randomUUID()]),/permission denied/,role);
      } finally {await db.query('ROLLBACK');}
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(db.query('SELECT * FROM research_benchmark_shortfalls'),/permission denied/,role);
      } finally {await db.query('ROLLBACK');}
    }
  });
}
