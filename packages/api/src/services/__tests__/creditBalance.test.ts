/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {creditBalanceDiagnostics,readCreditBalance} from '../creditBalance';
vi.mock('../../lib/logger',()=>({logger:{warn:vi.fn(),error:vi.fn()}}));
afterEach(()=>vi.useRealTimers());
const ok=(credits:number)=>new Response(JSON.stringify({credits}),{headers:{'Content-Type':'application/json'}});
function client(fetcher:typeof fetch){return createClient('http://127.0.0.1:9999','LOCAL_TEST_KEY',{global:{fetch:fetcher},auth:{persistSession:false,autoRefreshToken:false}});}
describe('bounded chat balance reads through the actual PostgREST SDK',()=>{
 it.each([['57014',500],['PGRST003',504]])('recovers %s with one fresh GET and returns the fresh value',async(code,status)=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({code,message:'private details'}),{status:Number(status)})).mockResolvedValueOnce(ok(0));
  expect(await readCreditBalance(client(fetcher),'actor',{recoverTransient:true})).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for(const [url,init]of fetcher.mock.calls){expect(url).toContain('select=credits');expect(url).toContain('id=eq.actor');expect(init.method).toBe('GET');expect(init.signal).toBeInstanceOf(AbortSignal);}
 });
 it.each([['42501',403],['PGRST301',401],['PGRST116',406],['XX000',500]])('never retries terminal %s',async(code,status)=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({code,message:'private detail'}),{status:Number(status)}));
  const error=await readCreditBalance(client(fetcher),'actor',{recoverTransient:true}).catch(e=>e);
  expect(creditBalanceDiagnostics(error)).toMatchObject({code,attempts:1});expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.stringify(creditBalanceDiagnostics(error))).not.toContain('private');
 });
 it.each([null,-1,'10',1.5])('does not substitute/retry invalid balance %s',async credits=>{
  const fetcher=vi.fn().mockResolvedValue(ok(credits as number));
  await expect(readCreditBalance(client(fetcher),'actor',{recoverTransient:true})).rejects.toMatchObject({reason:'invalid_balance'});expect(fetcher).toHaveBeenCalledOnce();
 });
 it('bounds a never-resolving fetch and aborts both attempts even when transport ignores the signal',async()=>{
  vi.useFakeTimers();const fetcher=vi.fn(()=>new Promise<Response>(()=>{}));
  const result=readCreditBalance(client(fetcher),'actor',{recoverTransient:true}).catch(e=>e);
  await vi.advanceTimersByTimeAsync(6100);const error=await result;
  expect(creditBalanceDiagnostics(error)).toEqual({reason:'timeout',code:'CLIENT_TIMEOUT',attempts:2,elapsedMs:6100});
  expect(fetcher).toHaveBeenCalledTimes(2);for(const call of fetcher.mock.calls)expect((call as any)[1].signal.aborted).toBe(true);
 });
 it('does not multiply the SDK network retries and leaves other callers on their existing behavior',async()=>{
  const fetcher=vi.fn().mockRejectedValue(new TypeError('fetch failed private-key-details'));
  const error=await readCreditBalance(client(fetcher),'actor',{recoverTransient:true}).catch(e=>e);
  expect(fetcher).toHaveBeenCalledTimes(2);expect(creditBalanceDiagnostics(error)).toMatchObject({reason:'network',attempts:2});
  expect(JSON.stringify(creditBalanceDiagnostics(error))).not.toContain('private');
  const normal=vi.fn().mockResolvedValue(new Response(JSON.stringify({code:'57014'}),{status:500}));
  await expect(readCreditBalance(client(normal),'actor')).rejects.toMatchObject({reason:'timeout'});expect(normal).toHaveBeenCalledOnce();
 });
 it('disables implicit 503 retries instead of turning each attempt into four HTTP requests',async()=>{
  const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({code:'PGRST003'}),{status:503})));
  await expect(readCreditBalance(client(fetcher),'actor',{recoverTransient:true})).rejects.toMatchObject({reason:'timeout'});expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it.each([503,520])('retains bounded transport recovery for status %s',async status=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response('unavailable',{status})).mockResolvedValueOnce(ok(15));
  expect(await readCreditBalance(client(fetcher),'actor',{recoverTransient:true})).toBe(15);expect(fetcher).toHaveBeenCalledTimes(2);
 });
});
