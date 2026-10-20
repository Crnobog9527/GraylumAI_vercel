/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {logger} from '../../lib/logger';

/** AC-0 measurement only. One recorder per HTTP invocation counts server round
 * trips and milliseconds under fixed labels and phases. It never keeps URLs,
 * query strings, headers, bodies, prompts, Skill text, user input, model output
 * or account identity; only labels, counts, milliseconds and internal UUIDs.
 * Every method swallows its own failure: timing never changes a request. */
export const TIMING_PHASES=['prelude','policy','host','admission','execute','rateLimit','provider'] as const;
export type TimingPhase=typeof TIMING_PHASES[number];
export const TIMING_MARKS=['providerPost','firstModelText','firstPublicText','fullModelReply','firstValidContent',
 'organizerStart','organizerPost','organizerReady','captureStart','captureDone','resultReady','resultPublic'] as const;
export type TimingMark=typeof TIMING_MARKS[number];
type Tally={rt:number;rtMs:number};
type PhaseTally=Tally&{ms:number};
type PreProvider={rt:number;rtMs:number;labels:Record<string,Tally>;phases:Record<string,PhaseTally>};
// organizerModel includes the provider call and its receipt/Session writes;
// provider fetch completion can be response headers, so it is not a model-end mark.
const SEGMENTS=['organizerPrepare','organizerModel','saving','capture','delivery'] as const;
type Segment=typeof SEGMENTS[number];
type SegmentTally=PhaseTally&{labels:Map<string,Tally>};

const NAME=/^[a-z][a-z0-9_]{0,62}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROCEDURE=/^[a-zA-Z][a-zA-Z0-9]{0,63}(\.[a-zA-Z][a-zA-Z0-9]{0,63}){1,3}$/;
const MAX_LABELS=64;
// The last database round trip before the provider POST. Its completion ends
// the "execute" phase for every transport, including the local fixture.
const DISPATCH_LABEL='rpc/bill2_dispatch';

/** Supabase paths become a fixed service/name label; everything else is coarse.
 * Only the path is parsed; query strings and hosts are never retained. */
export function timingLabel(input:RequestInfo|URL,database:boolean):string{
 try{return database?databaseLabel(new URL(input instanceof Request?input.url:String(input)).pathname):'provider';}
 catch{return 'other';}
}
function databaseLabel(path:string){
 const [service,version,kind,name]=path.split('/').filter(Boolean);
 if(version!=='v1')return 'other';
 if(service==='auth')return kind&&NAME.test(kind)?'auth/v1/'+kind:'auth/v1';
 if(service==='storage')return 'storage/v1';
 if(service!=='rest')return 'other';
 if(kind==='rpc')return name&&NAME.test(name)?'rpc/'+name:'rpc/?';
 return kind&&NAME.test(kind)?'rest/'+kind:'rest/?';
}

export function createRequestTiming(now:()=>number=()=>performance.now()){
 const origin=now();
 const phases=new Map<TimingPhase,PhaseTally>(),labels=new Map<string,Tally>();
 const segments=new Map<Segment,SegmentTally>();
 const marks:Partial<Record<TimingMark,number>>={},executions=new Set<string>();
 let skillFileRead=false;
 const afterSkillFile:Partial<Record<TimingMark,number>>={};
 let procedures:string[]=[],phase:TimingPhase='prelude',since=origin,holds=1,emitted=false;
 let segment:Segment|undefined,segmentSince=origin;
 let preProvider:PreProvider|undefined;
 const slot=(p:TimingPhase)=>{let s=phases.get(p);if(!s){s={rt:0,rtMs:0,ms:0};phases.set(p,s);}return s;};
 const safe=(fn:()=>void)=>{try{fn();}catch{/* measurement only */}};
 const switchTo=(next:TimingPhase)=>{const t=now();slot(phase).ms+=t-since;since=t;phase=next;};
 const segmentSlot=(name:Segment)=>{
  let s=segments.get(name);if(!s){s={rt:0,rtMs:0,ms:0,labels:new Map()};segments.set(name,s);}return s;
 };
 const switchSegment=(next:Segment|undefined)=>{
  if(segment===next)return;
  const t=now();if(segment)segmentSlot(segment).ms+=t-segmentSince;
  segment=next;segmentSince=t;if(next)segmentSlot(next);
 };
 const mark=(name:TimingMark)=>safe(()=>{
  if(name==='organizerReady'&&marks.organizerStart===undefined)return;
  if(marks[name]===undefined){
   marks[name]=now()-origin;
   if(name==='organizerStart')switchSegment('organizerPrepare');
   if(name==='organizerPost')switchSegment('organizerModel');
   if(name==='organizerReady')switchSegment('saving');
   if(name==='captureStart')switchSegment('capture');
   if(name==='captureDone'||name==='resultReady')switchSegment('delivery');
   if(name==='resultPublic')switchSegment(undefined);
  }
  if(skillFileRead&&afterSkillFile[name]===undefined)afterSkillFile[name]=now()-origin;
 });
 const ms=(value:number)=>Math.max(0,Math.round(value));
 function summary(){
  const end=now(),current=slot(phase);
  const phaseRows=Object.fromEntries(TIMING_PHASES.filter(p=>phases.has(p)).map(p=>{
   const s=phases.get(p)!;return [p,{rt:s.rt,rtMs:ms(s.rtMs),ms:ms(s.ms+(s===current?end-since:0))}];
  }));
  let rt=0,rtMs=0;for(const s of phases.values()){rt+=s.rt;rtMs+=s.rtMs;}
  return {
   procedures:[...procedures],executionIds:[...executions],totalMs:ms(end-origin),rt,rtMs:ms(rtMs),phases:phaseRows,
   ...(skillFileRead?{skillFileRead:true,afterSkillFileMarks:Object.fromEntries(
    TIMING_MARKS.filter(m=>afterSkillFile[m]!==undefined).map(m=>[m+'Ms',ms(afterSkillFile[m]!)]))}:{}),
   labels:Object.fromEntries([...labels].map(([label,s])=>[label,{rt:s.rt,rtMs:ms(s.rtMs)}])),
   ...(preProvider?{preProvider:structuredClone(preProvider)}:{}),
   ...(segments.size?{segments:Object.fromEntries(SEGMENTS.filter(name=>segments.has(name)).map(name=>{
    const s=segments.get(name)!;return [name,{rt:s.rt,rtMs:ms(s.rtMs),ms:ms(s.ms+(segment===name?end-segmentSince:0)),
     labels:Object.fromEntries([...s.labels].map(([label,t])=>[label,{rt:t.rt,rtMs:ms(t.rtMs)}]))}];
   }))}:{}),
   marks:Object.fromEntries(TIMING_MARKS.filter(m=>marks[m]!==undefined).map(m=>[m+'Ms',ms(marks[m]!)])),
  };
 }
 function emit(){
  // Only requests that reached a Runtime or positioning procedure are relevant.
  if(emitted||![...phases.keys(),phase].some(p=>p!=='prelude'))return;
  emitted=true;logger.info('api','runtime_request_timing',summary());
 }
 const recorder={
  /** Returns the completion callback for one transport call started now. */
  begin(label:string){
   let started=0,at:TimingPhase='prelude',inSegment:Segment|undefined;
   safe(()=>{started=now();at=phase;inSegment=segment;});
   return ()=>safe(()=>{
    const elapsed=now()-started,known=labels.has(label)||labels.size<MAX_LABELS?label:'other';
    const s=slot(at);s.rt++;s.rtMs+=elapsed;
    const l=labels.get(known)??{rt:0,rtMs:0};l.rt++;l.rtMs+=elapsed;labels.set(known,l);
    if(inSegment){
     const s=segmentSlot(inSegment);s.rt++;s.rtMs+=elapsed;
     const l=s.labels.get(known)??{rt:0,rtMs:0};l.rt++;l.rtMs+=elapsed;s.labels.set(known,l);
    }
    if(label===DISPATCH_LABEL&&marks.providerPost===undefined){
     // Only round trips completed by this boundary count. A request still in
     // flight belongs to the whole-invocation totals when it later completes.
     const snapshot=summary();
     preProvider={rt:snapshot.rt,rtMs:snapshot.rtMs,labels:snapshot.labels,phases:snapshot.phases};
     mark('providerPost');switchTo('provider');
    }
    if(label===DISPATCH_LABEL&&inSegment==='organizerPrepare')mark('organizerPost');
   });
  },
  /** Enters a phase; the returned callback restores the previous one. */
  enter(next:TimingPhase){
   let previous:TimingPhase=phase;
   safe(()=>{previous=phase;if(phase!=='provider')switchTo(next);});
   return ()=>safe(()=>{if(phase===next)switchTo(previous);});
  },
  // Durable execution completion ends provider timing before post-processing.
  finishProvider:()=>safe(()=>{if(phase==='provider')switchTo('host');}),
  mark,
  // Fixed category only: no Skill identity, paths, contents or user input.
  tagSkillFileRead:()=>safe(()=>{skillFileRead=true;}),
  tagExecution:(id:unknown)=>safe(()=>{if(typeof id==='string'&&UUID.test(id)&&executions.size<8)executions.add(id.toLowerCase());}),
  setProcedures:(paths:readonly unknown[])=>safe(()=>{
   procedures=paths.filter((p):p is string=>typeof p==='string'&&PROCEDURE.test(p)).slice(0,8);
  }),
  /** The route holds one reference and adds one per streamed procedure in its
   * batch, since those settle after the Response. The line is written once,
   * when the last reference is released. */
  retain:(count:number)=>safe(()=>{if(Number.isSafeInteger(count)&&count>0)holds+=count;}),
  release:()=>safe(()=>{if(--holds<=0)emit();}),
  summary,
  /** Makes this recorder current for services that do not receive the budget. */
  run:<T>(fn:()=>T):T=>scope.run(recorder,fn),
 };
 return recorder;
}
export type RequestTiming=ReturnType<typeof createRequestTiming>;

// Services that do not receive the invocation budget (admission) reach the
// same recorder through the request's async context. Losing it only moves
// their round trips into the enclosing phase.
const scope=new AsyncLocalStorage<RequestTiming>();
export function currentRequestTiming():RequestTiming|undefined{
 try{return scope.getStore();}catch{return undefined;}
}
