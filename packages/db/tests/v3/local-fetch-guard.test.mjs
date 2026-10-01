/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {installLocalFetchGuard} from './local-fetch-guard.cjs';

test('local guard maps only fixed synthetic origins and rejects every other non-loopback URL',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'fetch'),seen=[];
  try{
    globalThis.fetch=async input=>{seen.push(typeof input==='string'?input:input.url);return new Response('synthetic');};
    installLocalFetchGuard({stagingOrigin:'https://syntheticstaging.supabase.co',gatewayOrigin:'http://127.0.0.1:12345'});
    await fetch('https://syntheticstaging.supabase.co/rest/v1/profiles?select=id');
    await fetch(new Request('https://openrouter.ai/api/v1/chat/completions',{method:'POST',body:'{}'}));
    await fetch('http://localhost:12345/health');
    assert.deepEqual(seen,['http://127.0.0.1:12345/rest/v1/profiles?select=id','http://127.0.0.1:12345/__official_chat','http://localhost:12345/health']);
    for(const url of ['https://example.test','https://openrouter.ai/api/v1/models','https://another.supabase.co/rest/v1']) {
      assert.throws(()=>fetch(url),/LOCAL_ONLY_NETWORK/);
    }
  }finally{Object.defineProperty(globalThis,'fetch',descriptor);}
});

test('non-Next mode retains the original one-time guard and explicit local transport injection',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'fetch'),seen=[];
  try{
    globalThis.fetch=async input=>{seen.push(String(input));return new Response('synthetic');};
    installLocalFetchGuard();
    assert.throws(()=>fetch('https://example.test'),/LOCAL_ONLY_NETWORK/);
    const previous=globalThis.fetch;
    globalThis.fetch=async(_input,init)=>previous('http://127.0.0.1:12345/receipt',init);
    await fetch('https://openrouter.ai/api/v1/generation?id=synthetic');
    assert.deepEqual(seen,['http://127.0.0.1:12345/receipt']);
  }finally{Object.defineProperty(globalThis,'fetch',descriptor);}
});


test('one preload keeps both loopback guard and observer after Next child option normalization',()=>{
  const require=createRequire(new URL('../../../../apps/web/package.json',import.meta.url));
  const {getParsedNodeOptionsWithoutInspect,formatNodeOptions}=require('next/dist/server/lib/utils');
  const directory=mkdtempSync(resolve(tmpdir(),'ac14-preload-'));
  const previous=process.env.NODE_OPTIONS;
  try{
    const observer=resolve(directory,'observer.cjs'),preload=resolve(directory,'preload.cjs');
    writeFileSync(observer,'globalThis.__testObserverLoaded=true;');
    const helper=fileURLToPath(new URL('./local-fetch-guard.cjs',import.meta.url));
    writeFileSync(preload,`require(${JSON.stringify(helper)}).installLocalFetchGuard();require(${JSON.stringify(observer)});`);
    process.env.NODE_OPTIONS=`--require=${preload} --require=${observer}`;
    assert.equal(getParsedNodeOptionsWithoutInspect().require,observer);
    process.env.NODE_OPTIONS=`--require=${preload}`;
    const normalized=formatNodeOptions(getParsedNodeOptionsWithoutInspect()).nodeOptions;
    const child=spawnSync(process.execPath,['-e',`require('node:assert/strict').equal(globalThis.__testObserverLoaded,true);require('node:assert/strict').throws(()=>fetch('https://example.test'),/LOCAL_ONLY_NETWORK/);`],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:normalized}});
    assert.equal(child.status,0,child.stderr);
  }finally{
    if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;
    rmSync(directory,{recursive:true,force:true});
  }
});
