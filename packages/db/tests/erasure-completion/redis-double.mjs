/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// In-memory stand-in for the Upstash REST API on 127.0.0.1, so the off-database erasure manifest (0227)
// really syncs during local executor tests. Only SET (with NX / EXAT) is implemented, single or pipelined.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';

export async function startRedisDouble(){
 const store=new Map();
 const server=createServer((req,res)=>{
  let body='';req.on('data',chunk=>{body+=chunk;});
  const run=([command,key,value,...flags])=>{
   if(String(command).toUpperCase()!=='SET')return {error:'ERR unsupported in test double'};
   const options=flags.map(flag=>String(flag).toUpperCase());
   const at=options.indexOf('EXAT');
   if(options.includes('NX')&&store.has(key))return {result:null};
   store.set(key,{value,exat:at>=0?Number(flags[at+1]):null});
   return {result:'OK'};
  };
  req.on('end',()=>{
   const reply=(status,payload)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(payload));};
   try{
    assert.equal(req.headers.authorization,'Bearer local-test-token');
    const parsed=JSON.parse(body);
    // The client auto-pipelines: POST /pipeline with [[cmd,...],...] and expects [{result},...].
    if(req.url==='/pipeline')return reply(200,parsed.map(command=>run(command)));
    return reply(200,run(parsed));
   }catch(error){return reply(400,{error:String(error.message??error)});}
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const {port}=server.address();
 return {store,env:{UPSTASH_REDIS_REST_URL:`http://127.0.0.1:${port}`,UPSTASH_REDIS_REST_TOKEN:'local-test-token'},
  close:()=>new Promise(resolve=>server.close(resolve))};
}
