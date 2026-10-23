/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE keyword cards (0350 on 0263/0343): a keyword card offers 3–10 keywords and may be confirmed with up
// to 10; candidate cards keep their rules. Synthetic fixtures only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

const keywords = (count,tag) => Array.from({length:count},(_,i) => ({id:`k${i}`,text:`关键词${i} ${tag}`}));

export async function keywordCardCases({db,check,rpc,seed,answer}) {
  const create = (f,e,options,card=randomUUID()) => rpc(db,'research_card_create',f.actor,card,f.session,e,{kind:'keywords',options});

  await check('KEYWORDS a card offers 3–10 keywords and is confirmed with up to 10 of them, additions included', async () => {
    const f = await seed(db), e = await answer(db,f), tag = randomUUID().slice(0,6);
    const ten = await create(f,e,keywords(10,tag));
    assert.deepEqual([ten.minSelect,ten.maxSelect],[1,10]);
    await assert.rejects(create(f,e,keywords(11,tag)),/RESEARCH_CARD_INVALID/);
    await assert.rejects(create(f,e,keywords(2,tag)),/RESEARCH_CARD_INVALID/);
    const confirmed = await rpc(db,'research_card_confirm',f.actor,ten.cardId,{selected:keywords(9,tag).map(k=>k.id),
      additions:[`补充 ${tag}`]});
    assert.equal(confirmed.items.length,10);
    const three = await create(f,e,keywords(3,tag));
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,three.cardId,{selected:['k0','k1','k2'],
      additions:Array.from({length:8},(_,i)=>`多 ${i} ${tag}`)}),/RESEARCH_CARD_INVALID/,'never more than 10 in all');
  });

  await check('KEYWORDS the patch is repeatable and refuses a changed source', async () => {
    const migration = readFileSync(new URL('../../migrations/0350_research_keyword_cards.sql',import.meta.url),'utf8');
    const definition = async () => (await db.query(
      "SELECT pg_get_functiondef('public.research_card_create(uuid,uuid,uuid,uuid,jsonb)'::regprocedure) d")).rows[0].d;
    const before = await definition();
    assert.ok(before.includes('-- 0350 keywords'));
    await db.query(migration);
    assert.equal(await definition(),before);
    // The candidate rules are untouched (0263's 8–12 for a running discovery, 0343's small-niche exception if present).
    assert.ok(before.includes("n NOT BETWEEN 8 AND 12"));
    assert.ok(!before.includes("n NOT BETWEEN 3 AND 5"));
  });
}
