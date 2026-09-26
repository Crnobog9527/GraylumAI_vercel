/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect} from 'vitest';
import {openRouterEvidence} from './openRouterEvidence';
const identity={provider:'openrouter',account:'test-account',model:'test/model',protocol:'openrouter-chat-v1'} as const;
function observed(raw:string,status=200){return {rawBody:raw,rawBodyBase64:Buffer.from(raw).toString('base64'),sourceHash:'unused',httpStatus:status,complete:true,transportIssue:null};}
const raw='{"id":"gen-local","model":"test/model","choices":[{"finish_reason":"stop","message":{"content":"local"}}],"usage":{"cost":0.000000123456}}';
describe('OpenRouter private evidence projection',()=>{
 it.each([
  observed('{"error":{"message":"not ready"}}',404),
  observed('{"data":{"id":"gen-local","model":"test/model"}}',500),
  observed('{invalid'),
  {...observed(raw),complete:false},
  observed(raw.replace('"stop"','null')),
 ])('keeps incomplete/nonfinal transport observations recoverable', observation=>{
  expect(openRouterEvidence(observation,identity,'lookup','gen-local')).toMatchObject({evidenceKind:'transport_observation',cost:null,final:false});
 });

 it('preserves a terminal answer separately from unresolved cost',()=>{
  const evidence=openRouterEvidence(observed(raw.replace('"cost":0.000000123456','"tokens":7')),identity,'response');
  expect(evidence).toMatchObject({providerId:'gen-local',cost:null,final:false,usage:{sdkResponse:{choices:[{message:{content:'local'}}]}}});
  expect(evidence).not.toHaveProperty('rejectedReason');
 });
 it.each([['1.23456e-7','0.000000123456'],['1e-12','0.000000000001'],['0e+8','0'],['1.23e2','123']])('expands official JSON exponent %s without floating point', (cost,expected)=>expect(openRouterEvidence(observed(raw.replace('0.000000123456',cost)),identity,'response')).toMatchObject({cost:expected,final:true}));
 it.each(['1e-13','-1','1e999'])('retains unsupported numeric cost %s as unknown',cost=>expect(openRouterEvidence(observed(raw.replace('0.000000123456',cost)),identity,'response')).toMatchObject({cost:null,final:false}));
 it('retains malformed choice evidence without throwing',()=>expect(openRouterEvidence(observed(raw.replace('{"finish_reason":"stop","message":{"content":"local"}}','null')),identity,'response')).toMatchObject({providerId:'gen-local',cost:null,final:false}));
 it('retains unsupported precision as unknown without rounding',()=>expect(openRouterEvidence(observed(raw.replace('0.000000123456','0.000000123456789')),identity,'response')).toMatchObject({cost:null,final:false}));
 it('retains official total cost exactly, distinct from output use',()=>expect(openRouterEvidence(observed(raw),identity,'response')).toMatchObject({providerId:'gen-local',cost:'0.000000123456',final:true}));
 it('retains error response id without assigning final cost',()=>expect(openRouterEvidence(observed(raw,500),identity,'response')).toMatchObject({providerId:'gen-local',cost:null,final:false}));
 it('does not infer free usage from missing evidence',()=>expect(openRouterEvidence(observed(raw.replace('"cost":0.000000123456','"tokens":0')),identity,'response')).toMatchObject({cost:null,final:false}));
 it('checks lookup against original generation identity',()=>expect(openRouterEvidence(observed('{"data":{"id":"other","model":"test/model","finish_reason":"stop","total_cost":0}}'),identity,'lookup','gen-local')).toMatchObject({cost:null,final:false}));
 it('does not trust truncated bytes even when prefix looks complete',()=>expect(openRouterEvidence({...observed(raw),complete:false},identity,'response')).toMatchObject({providerId:null,cost:null,final:false}));
});

it.each([false,true])('a generation header is only lookup evidence, never cost (complete=%s)',complete=>{
 expect(openRouterEvidence({...observed(' '.repeat(165)),complete,generationId:'gen-header'},identity,'response')).toMatchObject({providerId:'gen-header',cost:null,final:false,evidenceKind:'transport_observation'});
});
it('accepts matching header/body identities and official cost',()=>{
 expect(openRouterEvidence({...observed(raw),generationId:'gen-local'},identity,'response')).toMatchObject({providerId:'gen-local',cost:'0.000000123456',final:true});
});
it.each([
 ['response',undefined,'gen-header',raw,true],
 ['lookup','gen-local','gen-wrong',' ',false],
 ['lookup','gen-local','gen-local','{"data":{"id":"wrong","model":"test/model","finish_reason":"stop","total_cost":0}}',true],
 ['lookup','gen-local',undefined,'{"data":{"id":"wrong","model":"test/model","finish_reason":"stop","total_cost":0}}',true],
] as const)('identity contradiction %# cannot bind an ID or settle', (source,expected,generationId,text,complete)=>{
 const evidence=openRouterEvidence({...observed(text),complete,...(generationId?{generationId}:{})},identity,source,expected);
 expect(evidence).toMatchObject({providerId:null,cost:null,final:false,rejectedReason:'identity_or_response_mismatch'});
 expect(evidence).not.toHaveProperty('evidenceKind'); // Existing SQL latches rejection; diagnostics alone do not.
});
it('does not let a header replace a missing body ID for finality',()=>{
 expect(openRouterEvidence({...observed(raw.replace('"id":"gen-local",','')),generationId:'gen-local'},identity,'response')).toMatchObject({providerId:'gen-local',cost:null,final:false,evidenceKind:'transport_observation'});
});
