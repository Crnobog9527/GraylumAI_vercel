/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bridge} from '../../../../../scripts/cdc-b2-eval/bridge';
import {quote} from '../../../../../scripts/cdc-b2-eval/policy';
import {openRouterBound} from '../bill2/openRouterPolicy';
it('serial sender settles a known cost and stops permanently on unknown cost without retry',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cdc-bridge-test-')),realFetch=globalThis.fetch;
 let sends=0;vi.stubGlobal('fetch',async(url:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1])=>{
  if(String(url)!=='https://openrouter.ai/api/v1/chat/completions')return realFetch(url,init);
  sends++;return new Response(JSON.stringify({choices:[{finish_reason:'stop'}],usage:sends===1?{cost:.001}:{}}));
 });
 const sender=await bridge(dir,[{slot:'a',role:'organizer'},{slot:'b',role:'organizer'}],'SYNTHETIC_LOCAL_TEST');
 const q=quote('organizer','fixture'),raw=JSON.stringify({model:q.model,max_tokens:2048,store:false,stream:false,messages:[],
  provider:openRouterBound(q.providerLimits,2048).routing});
 const send=(ordinal:number,slot:string)=>fetch(sender.url,{method:'POST',headers:{authorization:sender.secret},
  body:JSON.stringify({ordinal,slot,role:'organizer',raw})});
 try{
  expect((await send(1,'a')).status).toBe(200);
  expect(JSON.parse(readFileSync(dir+'/ledger.json','utf8'))).toMatchObject({nano:1000000,pending:false});
  expect((await send(2,'b')).status).toBe(409);
  expect(JSON.parse(readFileSync(dir+'/ledger.json','utf8'))).toMatchObject({pending:true,calls:{organizer:2}});
  expect((await send(2,'b')).status).toBe(409);expect(sends).toBe(2);
 }finally{await sender.close();vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});}
});
