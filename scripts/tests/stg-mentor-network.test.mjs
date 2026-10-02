/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireMentorProxy,checkOpenRouterUS} from '../stg-mentor-network.mjs';
const env={HTTPS_PROXY:'http://127.0.0.1:7897',HTTP_PROXY:'http://127.0.0.1:7897',NO_PROXY:'localhost,127.0.0.1,::1'};
test('explicit proxy activation, consistent env and no upstream bypass are mandatory',()=>{
  requireMentorProxy(env,['--use-env-proxy']);
  assert.throws(()=>requireMentorProxy(env,[]));
  for(const change of [{HTTPS_PROXY:''},{http_proxy:'http://elsewhere:80'},{NO_PROXY:'*'},{no_proxy:'.ai'},
    {HTTPS_PROXY:'socks5://localhost',HTTP_PROXY:'socks5://localhost'}])
    assert.throws(()=>requireMentorProxy({...env,...change},['--use-env-proxy']));
});
test('free same-host US trace passes without authentication or model payload; proof excludes IP',async()=>{
  const proof=await checkOpenRouterUS(async(url,options)=>{
    assert.equal(url,'https://openrouter.ai/cdn-cgi/trace');assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,undefined);assert.equal(options.body,undefined);
    return new Response('h=openrouter.ai\nip=private\nloc=US\n');
  });
  assert.equal(proof.country,'US');assert.ok(!JSON.stringify(proof).includes('private'));
});
test('missing, non-US, duplicate, oversized, refused and unknown trace stop without retry',async()=>{
  for(const value of ['h=openrouter.ai\nloc=CA','loc=US','h=elsewhere\nloc=US',
    'h=openrouter.ai\nloc=US\nloc=US','x'.repeat(4097),new Response('',{status:403}),null]){
    let calls=0;
    await assert.rejects(checkOpenRouterUS(async()=>{calls++;if(value===null)throw Error('sensitive');
      return value instanceof Response?value:new Response(value);}),/MENTOR_OPENROUTER_US_NOT_CONFIRMED/);
    assert.equal(calls,1);
  }
});
