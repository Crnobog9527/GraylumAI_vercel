/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {readGeminiUsageStream} from '../providerUsage';
import {nativeSearchCapability} from '../searchEvidence';
import {parseSearchSurcharge} from '../searchPricing';
const usage={promptTokenCount:10,candidatesTokenCount:2,totalTokenCount:12};
const stream=(events:unknown[])=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')).body!;
const candidate=(metadata:unknown)=>({candidates:[{index:0,content:{parts:[{text:'answer'}]},groundingMetadata:metadata,finishReason:'STOP'}],usageMetadata:usage});
it.each([0,1,3])('counts %s actual unique queries with repeated metadata',async count=>{
 const metadata={webSearchQueries:Array.from({length:count},(_,i)=>'query '+i)};
 const value=await readGeminiUsageStream(stream([candidate(metadata),{candidates:[{index:0,groundingMetadata:metadata}],usageMetadata:usage}]),undefined,undefined,'unique-query');
 expect(value.search).toMatchObject({queryCount:count,providerUnits:count});
});
it('separates per-prompt provider units from queries',async()=>{
 const v=await readGeminiUsageStream(stream([candidate({webSearchQueries:['one','two','two','']})]),undefined,undefined,'grounded-prompt');
 expect(v.search).toMatchObject({queryCount:2,providerUnits:1});
});
it.each([undefined,null,{}, {webSearchQueries:'one'}, {webSearchQueries:[3]}, {webSearchQueries:[],groundingChunks:[{web:{uri:'https://example.test'}}]}])('rejects missing/corrupt search evidence %j',async value=>{
 await expect(readGeminiUsageStream(stream([candidate(value)]),undefined,undefined,'unique-query')).rejects.toThrow();
});
it('preserves streamed content when metering cannot be verified',async()=>{
 let content='';await expect(readGeminiUsageStream(stream([candidate(undefined)]),undefined,v=>{content=v;},'unique-query')).rejects.toThrow();expect(content).toBe('answer');
});
it('rejects contradictory snapshots and response identities',async()=>{
 await expect(readGeminiUsageStream(stream([candidate({webSearchQueries:['one','two']}),candidate({webSearchQueries:['one']})]),undefined,undefined,'unique-query')).rejects.toThrow();
 await expect(readGeminiUsageStream(stream([{...candidate({webSearchQueries:['one']}),responseId:'a'},{...candidate({webSearchQueries:['one']}),responseId:'b'}]),undefined,undefined,'unique-query')).rejects.toThrow();
});
it('only exposes structured safe sources, never model prose',async()=>{
 const v=await readGeminiUsageStream(stream([candidate({webSearchQueries:['one'],groundingChunks:[{web:{uri:'https://example.test/a',title:'Source'}},{web:{uri:'javascript:alert(1)',title:'unsafe'}}]})]),undefined,undefined,'unique-query');
 expect(v.search?.sources).toEqual([{url:'https://example.test/a',title:'Source'}]);
});
it.each(['gemini-2.5-flash','gemini-3-flash-preview'])('requires native enabled google contract %s',modelId=>{
 const model={provider:'google',modelId,enableWebSearch:true};expect(nativeSearchCapability(model,false)).not.toBeNull();expect(nativeSearchCapability(model,true)).toBeNull();expect(nativeSearchCapability({...model,enableWebSearch:false},false)).toBeNull();expect(nativeSearchCapability({...model,provider:'custom'},false)).toBeNull();
});
it('rejects unreviewed models',()=>expect(nativeSearchCapability({provider:'google',modelId:'gemini-made-up',enableWebSearch:true},false)).toBeNull());
it.each([0,1,999999,'0','1','999999'])('accepts price %j',v=>expect(parseSearchSurcharge(v)).toBe(Number(v)));
it.each([undefined,null,'',' ',true,false,-1,'-1',1000000,'1000000',1.5,'1.5','01','1e2','0x10','NaN',Infinity,{},[]])('rejects price %j',v=>expect(parseSearchSurcharge(v)).toBeNull());
it('accepts query and source metadata arriving in separate SSE chunks',async()=>{
 const v=await readGeminiUsageStream(stream([candidate({webSearchQueries:['one']}),{candidates:[{index:0,groundingMetadata:{groundingChunks:[{web:{uri:'https://example.test/a',title:'Source'}}]}}]}]),undefined,undefined,'unique-query');
 expect(v.search).toMatchObject({queryCount:1,providerUnits:1,sources:[{url:'https://example.test/a',title:'Source'}]});
});
