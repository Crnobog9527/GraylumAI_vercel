/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFileSync,readFileSync,appendFileSync} from 'node:fs';
import {streamObserver} from '../../packages/api/src/scripts/ac0Probe/sse';
import {secondRound} from './secondRound';
import {budget,measure,EXPIRES,hash,type Role} from './policy';
/** The only external sending boundary. Caller must verify the exact PR authorization first. */
export async function bridge(output:string,slots:Array<{slot:string;role:Role}>,key:string){
 const ledgerPath=output+'/ledger.json';
 writeFileSync(ledgerPath,JSON.stringify({calls:{mentor:0,organizer:0},nano:secondRound.priorNano,pending:false}),{flag:'wx',mode:0o600});
 const gate=budget(()=>JSON.parse(readFileSync(ledgerPath,'utf8')),state=>writeFileSync(ledgerPath,JSON.stringify(state),{mode:0o600}));
 let next=0,busy=false,stopped=false;const secret=randomUUID()+randomUUID();
 const server=createServer(async(req,res)=>{
  try{
   if(stopped||busy||req.method!=='POST'||req.url!=='/request'||req.headers.authorization!==secret||Date.now()>=Date.parse(EXPIRES))
    throw new Error('CDC_AUTH_OR_SEQUENCE');
   busy=true;let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>262144)throw new Error('CDC_BODY_LIMIT');}
   const input=JSON.parse(raw),slot=slots[next];
   if(!slot||input.ordinal!==next+1||input.slot!==slot.slot||input.role!==slot.role)throw new Error('CDC_SLOT');
   const bound=measure(input.raw,input.role),settle=gate.reserve(input.role,bound.reserveNano);next++;
   const record={ordinal:next,role:slot.role,slot:slot.slot,...bound};
   appendFileSync(output+'/requests.jsonl',JSON.stringify({...record,raw:input.raw})+'\n',{mode:0o600});
   const upstream=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',redirect:'error',
    signal:AbortSignal.timeout(240000),headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:input.raw});
   if(!upstream.ok||!upstream.body)throw new Error('CDC_PROVIDER_REJECTED');
   const chunks:Uint8Array[]=[];let bytes=0;
   for await(const chunk of upstream.body){bytes+=chunk.byteLength;if(bytes>4*1024*1024)throw new Error('CDC_RESPONSE_LIMIT');chunks.push(chunk);}
   const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   let cost:number|undefined,finish:string|undefined;
   if(JSON.parse(input.raw).stream){
    const observer=streamObserver(()=>0);observer.push(Buffer.from(body));const facts=observer.end();
    if(!facts.done||facts.streamError||facts.malformedFrames)throw new Error('CDC_INCOMPLETE_STREAM');
    cost=facts.usage?.costUsd;finish=facts.finishReason;
   }else{const data=JSON.parse(body);cost=data.usage?.cost;finish=data.choices?.[0]?.finish_reason;}
   if(typeof cost!=='number'||!['stop','tool_calls'].includes(finish??''))throw new Error('CDC_COST_OR_FINISH_UNKNOWN');
   settle(cost);appendFileSync(output+'/responses.jsonl',JSON.stringify({...record,cost,responseHash:hash(body),body})+'\n',{mode:0o600});
   res.writeHead(200,{'content-type':upstream.headers.get('content-type')??'application/json'});res.end(body);busy=false;
  }catch{stopped=true;gate.stop();res.writeHead(409);res.end('CDC_STOP_NO_RETRY');}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();
 if(!address||typeof address==='string')throw new Error('CDC_BRIDGE');
 return {url:`http://127.0.0.1:${address.port}/request`,secret,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
