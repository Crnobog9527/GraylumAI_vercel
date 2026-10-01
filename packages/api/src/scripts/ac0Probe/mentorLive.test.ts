/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mentorSender,mentorMaxUsd,MENTOR_LIMITS,sha256,type MentorModel} from './mentorLive.ts';
import {fileLedger,acquireLedgerLock} from './ledger.ts';
import {memoryLedger,usdToNano} from './budget.ts';
import {sseResponse,textDeltas} from './dryRun.ts';
const directories:string[]=[];
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
const raw=(model:MentorModel='G',extra={})=>{
  const l=MENTOR_LIMITS[model];
  return JSON.stringify({model:l.model,max_tokens:l.tokens,reasoning_effort:l.effort,store:false,stream:false,
    messages:[{role:'user',content:'synthetic'}],provider:{allow_fallbacks:false,require_parameters:true,only:[l.route],
      max_price:{prompt:l.prompt,completion:l.completion,request:0}},...extra});
};
const reply=(cost:unknown=.001,model:string=MENTOR_LIMITS.G.model)=>new Response(JSON.stringify({id:'gen-fixture',model,
  choices:[{message:{content:'fixture'},finish_reason:'stop'}],usage:{cost,prompt_tokens:10,completion_tokens:5}}));
const slot=(id='one',model:MentorModel='G')=>({id,model,phase:'e2e' as const});
const setup=(options:Partial<Parameters<typeof mentorSender>[0]>={})=>{
  const upstream=vi.fn(async()=>reply());
  const ledger=memoryLedger({calls:737,nanoUsd:usdToNano(3.36)});
  const save=vi.fn();
  const sender=mentorSender({ledger,upstream,maxUsd:10.24,authorization:'Bearer fixture',save,
    slots:Array.from({length:50},(_,i)=>({...slot(String(i)),requestHash:''})),...options});
  return {sender,upstream,ledger,save};
};
describe('STG mentor live boundary without network',()=>{
  it('requires bounded --max-usd',()=>{
    for(const value of [undefined,'0','NaN','11','1e1','-1','10.240000001'])expect(()=>mentorMaxUsd(value)).toThrow();
    expect(mentorMaxUsd('10.24')).toBe(10.24);
  });
  it('reserves to the real file-ledger implementation before send; settles exactly once',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'mentor-ledger-'));directories.push(directory);
    const path=join(directory,'ledger.json');writeFileSync(path,JSON.stringify({calls:737,nanoUsd:100,external:[]}));
    const ledger=fileLedger(path),release=acquireLedgerLock(path);
    expect(()=>acquireLedgerLock(path)).toThrow('PROBE_LEDGER_LOCKED');
    const upstream=vi.fn(async()=>{expect(ledger.read().calls).toBe(738);expect(ledger.read().nanoUsd).toBeGreaterThan(100);return reply();});
    const {sender}=setup({ledger,upstream});
    await sender.send(raw(),slot('0'));
    expect(JSON.parse(readFileSync(path,'utf8'))).toMatchObject({calls:738,nanoUsd:100+usdToNano(.001),external:[]});
    await expect(sender.send(raw(),slot('0'))).rejects.toThrow('duplicate');
    expect(upstream).toHaveBeenCalledTimes(1);release();
  });
  it('refuses restart, absent ledger, foreign usage, and ledger-write failure before network',async()=>{
    for(const calls of [0,736,738,841])expect(()=>setup({ledger:memoryLedger({calls,nanoUsd:0})})).toThrow('BASELINE');
    const a=setup();a.ledger.write({calls:738,nanoUsd:0});await expect(a.sender.send(raw(),slot('0'))).rejects.toThrow('ledger_changed');
    expect(a.upstream).not.toHaveBeenCalled();
    const b=setup({ledger:{read:()=>({calls:737,nanoUsd:0}),write:()=>{throw Error('disk');}}});
    await expect(b.sender.send(raw(),slot('0'))).rejects.toThrow();expect(b.upstream).not.toHaveBeenCalled();
  });
  it('checks run dollars and cumulative dollars independently',async()=>{
    const a=setup({maxUsd:.001});await expect(a.sender.send(raw(),slot('0'))).rejects.toThrow();expect(a.upstream).not.toHaveBeenCalled();
    const b=setup({ledger:memoryLedger({calls:737,nanoUsd:usdToNano(25.239)})});
    await expect(b.sender.send(raw(),slot('0'))).rejects.toThrow();expect(b.upstream).not.toHaveBeenCalled();
  });
  it('shares one 104-call batch across all three models and refuses an extra call',async()=>{
    const slots=(['G','S','L'] as const).flatMap(model=>Array.from({length:MENTOR_LIMITS[model].calls},
      (_,i)=>({...slot(String(i),model),requestHash:''})));
    const upstream=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>reply(.001,JSON.parse(String(init?.body)).model));
    const a=setup({slots,upstream});
    for(const s of slots)await a.sender.send(raw(s.model),s);
    expect(a.ledger.read().calls).toBe(841);expect(a.sender.totals.run.calls).toBe(104);
    await expect(a.sender.send(raw(),slot('extra'))).rejects.toThrow();
    expect(upstream).toHaveBeenCalledTimes(104);
  });
  it('checks model count without transferring unused other-model allowances',async()=>{
    const a=setup();for(let i=0;i<46;i++)await a.sender.send(raw(),slot(String(i)));
    await expect(a.sender.send(raw(),slot('46'))).rejects.toThrow('model_cap');expect(a.upstream).toHaveBeenCalledTimes(46);
  });
  it('reserves against model dollars even when other models and the round have capacity',async()=>{
    const upstream=vi.fn(async()=>reply(.09)),a=setup({upstream});
    const large=raw('G',{messages:[{role:'user',content:'x'.repeat(88000)}]});
    for(let i=0;i<30;i++)await a.sender.send(large,slot(String(i)));
    await expect(a.sender.send(large,slot('30'))).rejects.toThrow('model_cap');
    expect(upstream).toHaveBeenCalledTimes(30);expect(a.sender.totals.run.nanoUsd).toBe(usdToNano(2.7));
  });
  it('checks model dollar cap separately from round cap',async()=>{
    const lraw=raw('L',{messages:[{role:'user',content:'x'.repeat(31000)}]});
    const a=setup({slots:Array.from({length:20},(_,i)=>({...slot(String(i),'L'),requestHash:''})),
      upstream:vi.fn(async()=>reply(.007,MENTOR_LIMITS.L.model))});
    // Known over-bound charge is booked then stops; it can never be hidden as the reserve.
    await expect(a.sender.send(lraw,slot('0','L'))).rejects.toThrow('actual_over_bound');
    expect(a.ledger.read().nanoUsd).toBe(usdToNano(3.36)+usdToNano(.007));
  });
  it.each([401,402,429,500])('keeps reservation and stops after HTTP %s',async(status)=>{
    const upstream=vi.fn(async()=>new Response('refused',{status})),a=setup({upstream});
    await expect(a.sender.send(raw(),slot('0'))).rejects.toThrow('provider_rejected');
    const reserved=a.ledger.read();expect(reserved.calls).toBe(738);expect(reserved.nanoUsd).toBeGreaterThan(usdToNano(3.36));
    await expect(a.sender.send(raw(),slot('1'))).rejects.toThrow();expect(upstream).toHaveBeenCalledTimes(1);
  });
  it.each([undefined,-1,'0.001',null])('stops with missing/invalid provider cost %s',async(cost)=>{
    const upstream=vi.fn(async()=>reply(cost===undefined?'missing':cost)),a=setup({upstream});
    await expect(a.sender.send(raw(),slot('0'))).rejects.toThrow('unknown_result');
    await expect(a.sender.send(raw(),slot('1'))).rejects.toThrow();expect(upstream).toHaveBeenCalledTimes(1);
  });
  it.each(['refusal','content_filter'])('stops after a paid model-level %s without another request',async(kind)=>{
    const upstream=vi.fn(async()=>new Response(JSON.stringify({id:'gen-fixture',model:MENTOR_LIMITS.G.model,
      choices:[{message:{content:'',...(kind==='refusal'?{refusal:'refused'}:{})},
        finish_reason:kind==='content_filter'?'content_filter':'stop'}],usage:{cost:.001}})));
    const a=setup({upstream});
    await expect(a.sender.send(raw(),slot('0'))).rejects.toThrow('provider_refused');
    await expect(a.sender.send(raw(),slot('1'))).rejects.toThrow();
    expect(upstream).toHaveBeenCalledTimes(1);expect(a.ledger.read().nanoUsd).toBe(usdToNano(3.361));
  });
  it('does not retry thrown transport errors or leak their text',async()=>{
    const upstream=vi.fn(async()=>{throw Error('secret');}),a=setup({upstream});
    await expect(a.sender.send(raw(),slot('0'))).rejects.toThrow('local_or_transport');
    expect(JSON.stringify(a.save.mock.calls)).not.toContain('secret');expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('requires original main bytes and rejects routing/output drift before send',async()=>{
    const a=setup({slots:[{...slot('0'),phase:'main-single-turn',requestHash:sha256(raw())}]});
    await expect(a.sender.send(raw('G',{max_tokens:8193}),{...slot('0'),phase:'main-single-turn'})).rejects.toThrow('main_bytes_changed');
    expect(a.upstream).not.toHaveBeenCalled();
    for(const extra of [{max_tokens:8193},{provider:{}},{cache_control:{}},{reasoning_effort:'high'}]){
      const b=setup();await expect(b.sender.send(raw('G',extra),slot('0'))).rejects.toThrow('request_profile');expect(b.upstream).not.toHaveBeenCalled();
    }
  });
  it('settles valid SSE only at complete EOF, and relays unchanged bytes',async()=>{
    const upstream=vi.fn(async()=>sseResponse(MENTOR_LIMITS.G.model,textDeltas('hello'),
      {finish:'stop',usage:{cost:.001,prompt_tokens:10,completion_tokens:5,total_tokens:15}}));
    const a=setup({upstream}),chunks:Uint8Array[]=[];
    await a.sender.send(raw('G',{stream:true}),slot('0'),{headers:()=>{},chunk:bytes=>{
      expect(a.ledger.read().nanoUsd).toBeGreaterThan(usdToNano(3.361));chunks.push(bytes);
    }});
    expect(Buffer.concat(chunks).toString()).toContain('[DONE]');expect(a.sender.totals.run.calls).toBe(1);
  });
  it('retains reserve for incomplete streams and stops concurrent sends',async()=>{
    const a=setup({upstream:vi.fn(async()=>new Response('data: {}\n\n'))});
    await expect(a.sender.send(raw('G',{stream:true}),slot('0'))).rejects.toThrow('incomplete_stream');
    let release!:(response:Response)=>void;
    const upstream=vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;})),b=setup({upstream});
    const first=b.sender.send(raw(),slot('0'));
    await expect(b.sender.send(raw(),slot('1'))).rejects.toThrow('previous_unsettled');release(reply());
    await expect(first).rejects.toThrow('stopped');expect(upstream).toHaveBeenCalledTimes(1);
  });
});

it('retains only bounded numeric HTTP error code, never sensitive upstream rejection data',async()=>{
  for(const code of [403,'secret-code']){
    const a=setup({upstream:vi.fn(async()=>new Response(JSON.stringify({error:{code,message:'secret-key',metadata:{raw:'private'}}}),{status:403}))});
    await expect(a.sender.send(raw(),slot('0'))).rejects.toThrow('provider_rejected');
    expect(a.save.mock.calls.at(-1)?.[0].providerErrorCode).toBe(code===403?403:null);
    expect(JSON.stringify(a.save.mock.calls)).not.toMatch(/secret-key|private|secret-code/);
    await expect(a.sender.send(raw(),slot('1'))).rejects.toThrow('stopped');
  }
});
