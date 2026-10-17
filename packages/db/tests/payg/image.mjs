/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB-2d (0278): one inline image per PAYG call, image price in U, library_document scope, erasure fields.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {financial} from './core.mjs';

const page = {width:1600,height:1131,dataUrlBytes:800023};
const tokens = (w,h) => 2*Math.ceil(w/14)*Math.ceil(h/14)+2048;

async function libraryDocument(db,actor,patch={}) {
  const id=randomUUID();
  await db.query(`INSERT INTO library_documents(id,actor_id,request_id,kind,format,purpose,filename,status,original_bytes)
    VALUES($1,$2,$3,$4,$5,'reference','scan.pdf',$6,1000)`,
  [id,actor,randomUUID(),patch.kind??'document',patch.format??'pdf',patch.status??'ready']);
  if (patch.deleted) await db.query('UPDATE library_documents SET deleted_at=now() WHERE id=$1',[id]);
  return id;
}

export async function imageCases({db,report,createFixture,claim,receipt}) {
  const ok=await createFixture(db,{phase:'library_ocr',image:{...page,imageUsd:'0.000001'}});
  const t=100+8192+tokens(1600,1131);
  assert.equal(ok.claimPayload.payg.promptTokensUpper,t);
  const c=await claim(db,ok,1,true);
  const frozen=(await db.query('SELECT upper_usd,payload FROM bill2_calls WHERE id=$1',[c.id])).rows[0];
  assert.equal(Number(frozen.upper_usd),Number(((t*1+1000*0)/1e6+tokens(1600,1131)*0.000001).toFixed(12)));
  assert.deepEqual(frozen.payload.payg.image,{...page,tokensUpper:tokens(1600,1131)});
  await receipt(db,ok,c,'0.002',{inputTokens:1800,outputTokens:200});
  const settled=(await db.query('SELECT budget_conflict,metering_exit,metering_missing FROM bill2_calls WHERE id=$1',[c.id])).rows[0];
  assert.deepEqual(settled,{budget_conflict:false,metering_exit:false,metering_missing:false});
  report.checks.push('0278: one image quote is admitted; U adds image price per image token; real page usage settles without metering flags');

  const textOnly=await createFixture(db,{phase:'library_ocr',image:{...page}});
  const p=structuredClone(textOnly.claimPayload);
  delete p.payg.image;p.payg.bytes=100;p.payg.promptTokensUpper=100+8192;p.upperUsd=((100+8192)/1e6).toFixed(12);
  await rpc(db,'bill2_claim',textOnly.actor,textOnly.run,1,p);
  report.checks.push('0278: a text call on an image route keeps the 0162 quote and U');

  const refusals=[
    ['image token ceiling not the formula',{image:{...page,tokensUpper:tokens(1600,1131)-1}}],
    ['image price missing from the route',{image:{...page,omitImageUsd:true}}],
    ['another purpose',{phase:'question',image:{...page}}],
    ['a sliver image',{image:{width:1000,height:40,dataUrlBytes:5000}}],
    ['an aspect above 4:1',{image:{width:400,height:1601,dataUrlBytes:5000,imageInput:{maxDataUrlBytes:819223,maxEdge:2048}}}],
    ['an edge above the route maximum',{image:{width:1601,height:1131,dataUrlBytes:5000}}],
    ['a route maximum above 2048',{image:{width:1600,height:1131,dataUrlBytes:5000,imageInput:{maxDataUrlBytes:819223,maxEdge:2049}}}],
    ['more image bytes than the route allows',{image:{...page,imageInput:{maxDataUrlBytes:5000,maxEdge:1600}}}],
    ['an extra key in the route allowance',{image:{...page,imageInput:{maxDataUrlBytes:819223,maxEdge:1600,detail:1}}}],
    ['text above 196,608 bytes',{bytes:196609,image:{...page}}],
  ];
  for (const [label,options] of refusals) {
    const f=await createFixture(db,{phase:'library_ocr',...options});
    await assert.rejects(rpc(db,'bill2_claim',f.actor,f.run,1,f.claimPayload),/BILL2_PAYG_QUOTE_INVALID/,label);
    assert.equal((await financial(db,f)).credits,100,label);
  }
  const mutate=async(label,change,expected=/BILL2_PAYG_(QUOTE_INVALID|BOUND_MISMATCH)/)=>{
    const f=await createFixture(db,{phase:'library_ocr',image:{...page,imageUsd:'0.000001'}});
    const payload=structuredClone(f.claimPayload);change(payload);
    await assert.rejects(rpc(db,'bill2_claim',f.actor,f.run,1,payload),expected,label);
    assert.equal((await financial(db,f)).credits,100,label);
  };
  await mutate('U without the image price',p2=>{p2.upperUsd=(p2.payg.promptTokensUpper/1e6).toFixed(12);});
  await mutate('T counting the base64 length',p2=>{p2.payg.promptTokensUpper=p2.payg.bytes+8192;});
  await mutate('an extra key in the image',p2=>{p2.payg.image.detail=1;});
  await mutate('image bytes equal to the whole request',p2=>{p2.payg.image.dataUrlBytes=p2.payg.bytes;});
  await mutate('a non-integer image width',p2=>{p2.payg.image.width='1600';});
  report.checks.push('0278: image quotes are refused for wrong T/U, shapes, purposes, missing price or allowance, with no hold');

  // library_document scope
  const owner=randomUUID();
  await db.query('INSERT INTO profiles(id,credits) VALUES($1,100)',[owner]);
  await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
    idempotency_key,balance_before,balance_after) VALUES($1,100,'addition','grant','opening_grant','system',$2,0,100)`,
  [owner,'opening_grant:'+owner]);
  const allowed=async(scope,actor=owner)=>(await db.query('SELECT bill2_scope_allowed($1,$2) ok',[actor,scope])).rows[0].ok;
  const doc=await libraryDocument(db,owner);
  assert.equal(await allowed({kind:'library_document',documentId:doc}),true);
  assert.equal(await allowed({kind:'library_document',documentId:doc.toUpperCase()}),true);
  assert.equal(await allowed({kind:'library_document',documentId:doc},randomUUID()),false);
  assert.equal(await allowed({kind:'library_document',documentId:doc,draftId:randomUUID()}),false);
  assert.equal(await allowed({kind:'library_document',documentId:'not-a-uuid'}),false);
  for (const patch of [{status:'deleting'},{status:'uploading'},{status:'failed'},{deleted:true},{kind:'image',format:'jpeg'},{format:'txt'}])
    assert.equal(await allowed({kind:'library_document',documentId:await libraryDocument(db,owner,patch)}),false,JSON.stringify(patch));
  assert.equal(await allowed({kind:'library_document',documentId:await libraryDocument(db,owner,{format:'docx',status:'processing'})}),true);
  const draft=await rpc(db,'bill2_create_draft',owner);
  assert.equal(await allowed({kind:'positioning_draft',draftId:draft}),true,'earlier scope kinds keep their rules');

  const scoped=await createFixture(db,{actor:owner,phase:'library_ocr',image:{...page},operation:'work',
    scope:{kind:'library_document',documentId:doc}});
  const sc=await claim(db,scoped,1,true);
  await receipt(db,scoped,sc,'0.001',{inputTokens:1700,outputTokens:100});
  await db.query("UPDATE library_documents SET status='deleting' WHERE id=$1",[doc]);
  await assert.rejects(rpc(db,'bill2_claim',owner,scoped.run,2,scoped.claimPayload),/BILL2_(RUN|SCOPE)_DENIED/);
  await assert.rejects(createFixture(db,{actor:owner,phase:'library_ocr',image:{...page},operation:'work',
    scope:{kind:'library_document',documentId:doc}}),/BILL2_SCOPE_DENIED/);
  report.checks.push('0278: library_document scope admits only the actor\'s own processing/ready PDF or Word; deletion stops new calls');

  // Erasure keeps the image's financial fields, never content.
  const call=(await db.query('SELECT bill2_erasure_call_payload($1) v',[ok.claimPayload])).rows[0].v;
  assert.deepEqual(call.payg.image,{...page,tokensUpper:tokens(1600,1131)});
  assert.equal(call.providerLimits.imageUsd,'0.000001');
  const run=(await db.query('SELECT bill2_erasure_run_payload($1) v',[ok.payload])).rows[0].v;
  assert.deepEqual(run.callPolicy[0].payg.imageInput,{maxDataUrlBytes:819223,maxEdge:1600});
  assert.equal(run.callPolicy[0].providerLimits.imageUsd,'0.000001');
  report.checks.push('0278: erasure projections retain image sizes, token ceiling and image price');
}
