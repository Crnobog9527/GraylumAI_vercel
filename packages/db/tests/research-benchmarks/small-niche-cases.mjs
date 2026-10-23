/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-SHORTFALL small niche (0343 on 0320): a round searched to the end with fewer than 8 selectable accounts
// still shows a first candidate card, so a small niche can reach the shortfall choice. Synthetic fixtures only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const candidate = (id,account,selectable=true) => ({id,platform:'tiktok',account,evidenceRef:'e1#'+id,label:'@'+account,selectable});

export async function smallNicheCases({db,check,rpc,seed,answer,fetchAccount,imitable,gate}) {
  /** One keyword card confirmed and its discovery started (running until the search reaches the end). */
  async function discovery(f,e) {
    const card = randomUUID(), tag = card.slice(0,6);
    await rpc(db,'research_card_create',f.actor,card,f.session,e,{kind:'keywords',
      options:[{id:'k0',text:`抽纱 ${tag}`},{id:'k1',text:`刺绣 ${tag}`},{id:'k2',text:`针法 ${tag}`}]});
    const confirmed = await rpc(db,'research_card_confirm',f.actor,card,{selected:['k0','k1','k2']});
    return (await rpc(db,'research_discovery_start',f.actor,f.session,e,confirmed.confirmationId,['tiktok'])).discoveryId;
  }
  const complete = (f,d) => rpc(db,'research_discovery_save',f.actor,f.session,d,{},'completed');
  const firstCard = (f,e,d,options,card=randomUUID()) =>
    rpc(db,'research_card_create',f.actor,card,f.session,e,{kind:'candidates',discoveryId:d,options});
  const offer = (f,e) => rpc(db,'research_benchmark_shortfall_offer',f.actor,f.session,e,randomUUID());
  const tag = () => randomUUID().slice(0,6);

  await check('SMALL NICHE a first card below 8 only for a completed discovery; picks stay all-of-them below 3', async () => {
    const f = await seed(db), e = await answer(db,f), d = await discovery(f,e);
    const two = [candidate('c0',`a-${tag()}`),candidate('c1',`b-${tag()}`),candidate('h0',`big-${tag()}`,false)];
    await assert.rejects(firstCard(f,e,d,two),/RESEARCH_CARD_INVALID/,'a running discovery keeps 8–12');
    await complete(f,d);
    const card = await firstCard(f,e,d,two);
    assert.deepEqual([card.minSelect,card.maxSelect],[2,2]);
    await assert.rejects(firstCard(f,e,d,[candidate('h1',`big-${tag()}`,false)]),/RESEARCH_CARD_INVALID/,'no selectable: no card');
    const five = await firstCard(f,e,d,['a','b','c','d','e'].map(x=>candidate('c'+x,`${x}-${tag()}`)));
    assert.deepEqual([five.minSelect,five.maxSelect],[3,5]);
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,card.cardId,{selected:['c0']}),/RESEARCH_CARD_INVALID/);
    assert.equal((await rpc(db,'research_card_confirm',f.actor,card.cardId,{selected:['c0','c1']})).items.length,2);
    // Another session's completed discovery never unlocks a small card here.
    const g = await seed(db), ge = await answer(db,g), gd = await discovery(g,ge);
    await complete(g,gd);
    await assert.rejects(firstCard(f,e,gd,two),/RESEARCH_CARD_INVALID/);
  });

  await check('SMALL NICHE picks from small cards: 1 qualified after 2 completed rounds gets the shortfall card', async () => {
    const f = await seed(db), e = await answer(db,f);
    const d1 = await discovery(f,e);
    await complete(f,d1);
    const card = await firstCard(f,e,d1,[candidate('c0',`q-${tag()}`),candidate('c1',`low-${tag()}`)]);
    const picked = await rpc(db,'research_card_confirm',f.actor,card.cardId,{selected:['c0','c1']});
    const [q,low] = picked.items.map(x=>x.account);
    await fetchAccount(f,e,q,imitable);
    await fetchAccount(f,e,low,{...imitable,followers:900});
    assert.equal((await rpc(db,'research_user_shortfall',f.actor,f.session)).qualified,1);
    await assert.rejects(offer(f,e),/RESEARCH_SHORTFALL_NOT_DUE/,'one round');
    await complete(f,await discovery(f,e));
    const shortfall = await offer(f,e);
    assert.deepEqual([shortfall.offeredQualified,shortfall.offeredRounds,shortfall.choice],[1,2,null]);
    await rpc(db,'research_benchmark_shortfall_choose',f.actor,shortfall.cardId,'generate');
    await gate(f);
  });

  await check('SMALL NICHE 0 qualified from small cards never gets the generate choice', async () => {
    const f = await seed(db), e = await answer(db,f);
    const d1 = await discovery(f,e);
    await complete(f,d1);
    const card = await firstCard(f,e,d1,[candidate('c0',`low-${tag()}`)]);
    const [low] = (await rpc(db,'research_card_confirm',f.actor,card.cardId,{selected:['c0']})).items.map(x=>x.account);
    await fetchAccount(f,e,low,{...imitable,followers:900});
    await complete(f,await discovery(f,e));
    assert.deepEqual(await rpc(db,'research_user_shortfall',f.actor,f.session),{rounds:2,qualified:0,card:null});
    await assert.rejects(offer(f,e),/RESEARCH_SHORTFALL_NOT_DUE/);
    await assert.rejects(gate(f),/REPORT_BENCHMARKS_REQUIRED/);
  });
}
