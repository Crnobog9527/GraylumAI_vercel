'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Fragment,Suspense,useEffect,useState,useRef,useMemo } from 'react';
import {AgentWorkStatus} from '@/components/chat-display/agent-work-status';
import {TurnSteps} from '@/components/chat-display/turn-steps';
import {runtimeTurnProgress} from './runtime-turn-progress';
import {streamedWorkItems} from '@/components/chat-display/agent-work-model';
import { useRouter, useSearchParams } from 'next/navigation';
import { classifyErasureError } from '@/lib/content-erasure';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { CHAT_ACTION, ChatInlineNotice, ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import {
 RuntimeEmptyState, RuntimeHeader, RuntimePendingMessage, RuntimeProposal, RuntimeReply, RuntimeResultsSection, RuntimeTurnView,
 RuntimeTypePendingPanel,
} from '@/components/chat-display/runtime-messages';
import { followTranscript, transcriptSignature } from '@/components/chat/chat-scroll';
import { WorkComposer } from '@/components/opc/work-composer';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { ContentEditor } from '@/components/opc/content-editor';
import { SaveReplyButton, SessionResultsPanel } from '@/components/opc/session-results';
import composerStyles from '@/components/opc/work-composer.module.css';
import workStyles from './runtime-work.module.css';
import {
 clearForSend, forgetPending, markPendingRestored, openingDraftWithReferences, readPending, rememberPending, requestIdFor,
 saveDraftReferences,
} from './send-input';
import {
 COMPOSER_REFERENCES_ENABLED, mergeReferences, referenceRequest, referencesNamedIn, type LibraryReference,
} from '@/components/opc/composer-references';
import { QueryNotice } from '@/components/opc/query-notice';
import { trpc } from '@/trpc/client';
import { RUNTIME_CHOICES_STALE_MS } from '@/lib/runtime-choices';
import {
 OUTPUT_TRUNCATED_NOTICE, definiteRefusal, definiteRefusalNotice, gateStopNotices, rememberGateStop, userStopIds,
 isLibrarySourceDeleted, libraryReferenceRefusal,
 runtimeAdmissionNotice, runtimeExecutionNotice, showsReply,
 videoGateError, videoGateNotice,
} from './gate-notices';
import { ENDED_NOTICE, GUIDE_HELD_NOTICE, isOpenTurn, runtimeModeSubtitle, runtimeTailNotices, runtimeTurnNotices, stopWithRecord,
  type RuntimeTurn } from './runtime-notices';
import { finishedExecution } from '@/lib/finished-execution';
import { isOrganizerPendingError } from '@/lib/payg-wait';
import { usePaygResume } from '@/lib/use-payg-resume';
import { useRuntimeViewBusy, useRuntimeViewPolling, useRuntimeViewSettled, useRuntimeViewStreaming } from '@/lib/runtime-view-poll';
import { useRuntimeStream } from './use-runtime-stream';
import { TurnWorkspace } from './turn-workspace';
import { CompareButton } from '@/components/fusion-compare/ComparePicker';
import { CompareThread, placeCompareCards, useCompareThread } from '@/components/fusion-compare/CompareThread';
import { LiveReplyText, PendingLiveReply, liveReplyText, liveScrollSignature, withResumeStop } from './runtime-live-reply';

type VideoChoice='both'|'storyboard'|'editing';
type VideoOperation={workItemId:string;choice?:VideoChoice;script:{requestId:string;executionId:string;expectedVersion:number};followup:{requestId:string;input:string;selection:{kind:'skill';moduleId:string;revisionId:string};executionId?:string};package:{requestId:string;expectedStoryboardVersion:number;expectedEditingVersion:number};sourceScriptId?:string;held?:boolean};
type ScriptOperation={kind?:'brief'|'script';workItemId:string;requestId:string;executionId:string;expectedVersion:number};
type ContentVersion={id:string;kind:string;version:number;status:string;body:string|null;sourceContentId:string|null;executionId:string|null;requestId:string};
const videoDefiniteRejections=new Set(['OPC_CONTENT_OUTPUT_TRUNCATED','OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_CONTENT_DENIED','OPC_CONTENT_BINDING','OPC_CONTENT_RESPONSE_INVALID','OPC_CONTENT_SOURCE','OPC_CONTENT_ALREADY_GENERATED','OPC_CONTENT_CHOICE_INVALID','OPC_STORYBOARD_REQUIRED','OPC_VIDEO_TYPE_REQUIRED']);
const scriptDefiniteRejections=new Set(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_CONTENT_DENIED','OPC_CONTENT_INVALID','OPC_CONTENT_SOURCE','OPC_VIDEO_TYPE_REQUIRED']);


// Presentation only: preserve the immutable Runtime request/result for replay.
function displayReply(input:string|null,body:string|null){
 if(!body)return '正在核实结果，请保留原任务。';
 const fenced=body.match(/```json\s*([\s\S]*?)\s*```/);
 const json=(fenced?.[1]??body).trim();
 if(json.startsWith('[')){try{const topics=JSON.parse(json);if(Array.isArray(topics)&&topics.length>0&&topics.every(topic=>topic&&typeof topic.title==='string'&&typeof topic.brief==='string'&&typeof topic.platform==='string'&&typeof topic.account==='string'))return [fenced?body.slice(0,fenced.index).trim():'',...topics.map((topic,index)=>`${index+1}. ${topic.title}\n${topic.platform} · ${topic.account}\n${topic.brief}`)].filter(Boolean).join('\n\n');}catch{/* A non-topic reply stays verbatim. */}}
 if(!input?.startsWith('[OPC_VIDEO_PACKAGE_V1]'))return body;
 try{const value=JSON.parse(body);if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>['storyboard','editing'].includes(key))){const parts=[];if(typeof value.storyboard==='string')parts.push('分镜脚本\n'+value.storyboard);if(typeof value.editing==='string')parts.push('剪辑建议\n'+value.editing);if(parts.length)return parts.join('\n\n');}}catch{/* Incomplete output stays recoverable; protocol text is not conversation. */}
 return '生成结果尚未整理完成，请保留原任务并恢复核对。';
}
/** What the transcript shows for a stored input: protocol markers become the user's plain request. */
function shownRuntimeInput(input:string){
 if(!input.startsWith('[OPC_VIDEO_PACKAGE_V1]'))return input.replace(/^\[OPC_SCRIPT_V1\]\s*/, '');
 return input.includes('只生成分镜脚本')?'请基于已定稿口播稿生成分镜脚本。':input.includes('只生成剪辑建议')?'请基于已保存的分镜生成剪辑建议。':'请先完成分镜脚本，再基于分镜生成剪辑建议。';
}
/** Session storage when available; private modes and the server render have none. */
function browserSession(){try{return typeof window==='undefined'?null:window.sessionStorage;}catch{return null;}}
function transcriptDay(value:string){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
function transcriptDate(value:string){const day=transcriptDay(value),today=transcriptDay(new Date().toISOString());const time=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));return day===today?'今天 '+time:day.replaceAll('-','/')+' '+time;}

export default function RuntimePage(){return <Suspense fallback={<p>正在读取工作…</p>}><RuntimeRoute/></Suspense>}
function RuntimeRoute(){
 const params=useSearchParams();
 const routeSession=params.get('session')??'';
 const routeModule=params.get('module')??'';
 return <RuntimePath key={routeSession||'new:'+routeModule} routeSession={routeSession} routeModule={routeModule}/>;
}
/** CORE-PATH-V2 V2-10: with core_path_v2.enabled a free conversation runs on the turn path; work items stay on the old one until V2-10b. */
function RuntimePath({routeSession,routeModule}:{routeSession:string;routeModule:string}){
 const choices=trpc.runtime.choices.useQuery(routeSession?{sessionId:routeSession}:undefined,{staleTime:RUNTIME_CHOICES_STALE_MS});
 const onTurns=Boolean(routeSession&&choices.data?.corePathV2);
 const view=trpc.runtime.view.useQuery({sessionId:routeSession},{enabled:onTurns});
 if(onTurns&&!view.data&&!view.error)return <p>正在读取工作…</p>;
 // A conversation that already holds old-path history stays on the old path: the turn path reads session_messages only, so it would
 // show the earlier talk without the model having it. V2-12 moves that history before the old path goes.
 const oldHistory=Boolean((view.data?.executions as unknown[]|undefined)?.length);
 if(onTurns&&view.data?.scope?.kind==='positioning_draft'&&!oldHistory)return <TurnWorkspace sessionId={routeSession}/>;
 return <RuntimeWorkspace routeSession={routeSession} routeModule={routeModule}/>;
}
function RuntimeWorkspace({routeSession,routeModule}:{routeSession:string;routeModule:string}){
 const utils=trpc.useUtils();
 const profile=trpc.user.getUserProfile.useQuery();
 const [sessionId,setSession]=useState(routeSession),[input,setInput]=useState(''),[selection,setSelection]=useState(''),[error,setError]=useState('');
 const [capacityIds,setCapacityIds]=useState<string[]>([]);
 // The user's message, shown at once until the server records its turn.
 const [outgoing,setOutgoing]=useState<{text:string;executionId?:string}|null>(null);
 const [gateStops,setGateStops]=useState<Record<string,string>>({});
 const [userStops,setUserStops]=useState<string[]>([]);
 const capacityKey=(executionId:string)=>'opc-runtime-capacity:'+sessionId+':'+executionId;
 function markCapacity(executionId:string){try{sessionStorage.setItem(capacityKey(executionId),'1');}catch{/* The current alert still explains the failure. */}setCapacityIds(ids=>ids.includes(executionId)?ids:[...ids,executionId]);}
 const [storedModule,setStoredModule]=useState('');
 const requestedModule=routeModule;
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 // UI-B: the draft's library references come back with its text (both from this browser's storage). With the switch
 // off the box shows no tags that could remove them, so stored references are never loaded or sent.
 const [references,setReferences]=useState<LibraryReference[]>([]);
 useEffect(()=>{if(!sessionId)return;const draft=openingDraftWithReferences(localStorage,sessionId);
  // Switch off: forget the stored list. Switch on: keep only references the restored text still names.
  if(!COMPOSER_REFERENCES_ENABLED)saveDraftReferences(localStorage,sessionId,[]);
  setReferences(COMPOSER_REFERENCES_ENABLED?referencesNamedIn(draft.text,draft.references):[]);setInput(draft.text);},[sessionId]);
 function updateReferences(next:LibraryReference[]){setReferences(next);if(sessionId)saveDraftReferences(localStorage,sessionId,next);}
 useEffect(()=>{setStoredModule(sessionId?localStorage.getItem('opc-runtime-skill:'+sessionId)??'':'');},[sessionId]);
 function updateInput(value:string){setInput(value);if(sessionId)localStorage.setItem('opc-runtime-input:'+sessionId,value);}
 const choices=trpc.runtime.choices.useQuery(sessionId?{sessionId}:undefined,{staleTime:RUNTIME_CHOICES_STALE_MS});
 const viewPolling=useRuntimeViewPolling();
 const view=trpc.runtime.view.useQuery({sessionId},{enabled:Boolean(sessionId),...viewPolling.options});
 const router=useRouter();
 // A deleted conversation (here, in another tab, or just before a reload) never stays open: start a new one.
 // NOT_FOUND (someone else's or a missing one, which read the same) leaves the same way.
 const erased=Boolean(view.error)&&(classifyErasureError(view.error,'preview').type==='gone'||view.error?.data?.code==='NOT_FOUND');
 useEffect(()=>{if(erased)router.replace('/app/positioning');},[erased,router]);
 // A resumed turn may settle charges: re-read the balance as each streamed turn does.
 // "继续" streams too: the same execution and resume token over runtime.resumeStream (runner is declared below).
 const payg=usePaygResume(()=>Promise.all([view.refetch(),utils.credits.getBalance.invalidate()]),undefined,token=>runner.resume(token));
 const saved=trpc.opc.workResults.useQuery({sessionId},{enabled:Boolean(sessionId&&view.data?.scope?.kind==='work_item')});
 const saveWorkResult=trpc.opc.saveWorkResult.useMutation();
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null},{enabled:Boolean(sessionId&&view.data?.scope?.kind==='work_item')});
 // C1-lite: an ordinary free conversation's results folder (the database refuses other sessions).
 const freeChat=Boolean(sessionId&&view.data?.scope?.kind==='positioning_draft');
 const results=trpc.opc.sessionResults.useQuery({sessionId},{enabled:freeChat,retry:false});
 const [panelOpen,setPanelOpen]=useState(true),[guiding,setGuiding]=useState(false);
 const [revealResults,setRevealResults]=useState(0);
 const guidanceAttempt=useRef(false);
 const [typePending,setTypePending]=useState(false);
 const editItem=trpc.opc.editLibrary.useMutation();
 const saveContent=trpc.opc.saveContentResult.useMutation(),prepareVideoMaterial=trpc.opc.prepareVideoMaterial.useMutation(),checkVideo=trpc.opc.checkVideoExecution.useMutation(),saveResults=trpc.opc.saveVideoResults.useMutation();
 const start=trpc.runtime.start.useMutation(),prepare=trpc.runtime.prepare.useMutation(),cancel=trpc.runtime.cancel.useMutation();
 // Every execution streams (runtime.executeStream); the result is the one runtime.execute returned.
 const runner=useRuntimeStream(sessionId,(executionId,result)=>{
  const notice=runtimeExecutionNotice(result);if(notice)setError(notice);
  const stop=rememberGateStop(browserSession(),sessionId,executionId,result);if(stop)setGateStops(stops=>({...stops,[executionId]:stop}));
 });
 const [videoBusy,setVideoBusy]=useState(false),[,setVideoUiRevision]=useState(0);
 const busy=start.isPending||prepare.isPending||runner.streaming||videoBusy||guiding||payg.busy;
 // A sent message whose execution is not in the view yet also keeps the view polling quickly.
 const outgoingUnseen=Boolean(outgoing&&!(view.data?.executions as Array<{executionId:string}>|undefined)?.some(e=>e.executionId===outgoing.executionId));
 useRuntimeViewBusy(viewPolling,busy||outgoingUnseen,view.refetch,Boolean(sessionId));
 // DB-PERF 5b: no timed reads while this page's stream is open and the view lists its execution; its close reads once.
 useRuntimeViewSettled(view.data,()=>void utils.credits.getBalance.invalidate());
 useRuntimeViewStreaming(viewPolling,runner.streaming?runner.reply?.executionId??null:null,()=>view.refetch({cancelRefetch:false}),Boolean(sessionId));
 const ordinary=choices.data?.models[0]?.id??'';
 const moduleSelection=requestedModule||storedModule;
 const chosenModule=choices.data?.skills.find(skill=>skill.moduleId===moduleSelection);
 const activeSelection=selection||(moduleSelection?(chosenModule?'skill:'+chosenModule.moduleId:''):(choices.data?.defaultSkill?'skill:'+choices.data.defaultSkill.moduleId:ordinary));
 const scrollArea=useRef<HTMLDivElement>(null);
 const scrollState=useRef({key:'',follow:true,signature:''});
 const scrollKey=profile.data?.id&&sessionId?'opc-runtime-scroll:'+profile.data.id+':'+sessionId:'';
 function rememberScroll(){const node=scrollArea.current;if(!node||!scrollKey||scrollState.current.key!==scrollKey)return;scrollState.current.follow=node.scrollHeight-node.clientHeight-node.scrollTop<80;try{sessionStorage.setItem(scrollKey,String(node.scrollTop));}catch{/* Browsing remains available without session storage. */}}
 const workItem=useMemo(()=>{
  const id=view.data?.scope?.kind==='work_item'?view.data.scope.workItemId:'';
  for(const business of library.data?.businesses??[])for(const account of business.accounts??[])for(const item of account.items??[])if(item.workItemId===id)return {...item,businessName:business.name,platform:account.platform,account:account.account,stage:account.stage};
  return null;
 },[library.data,view.data?.scope]);
 const workContextReady=!sessionId||Boolean(view.data&&(view.data.scope?.kind!=='work_item'||(library.data&&workItem)));
 const contentType=workItem?.contentType??'unknown';
 const isVideo=contentType==='video';
 const typeLabel:Record<string,string>={unknown:'类型待确认',article:'文章',image_text:'图文',video:'视频'};
 useEffect(()=>{if(workItem)setTypePending(Boolean(localStorage.getItem('opc-content-type:'+workItem.workItemId)));},[workItem?.workItemId]);
 const versions=(workItem?.content??[]) as ContentVersion[];
 async function persistSkillResult(executionId:string){
  setError('');
  try{await saveWorkResult.mutateAsync({executionId});await saved.refetch();}
  catch{await saved.refetch();setError('Skill 成果保存结果待核实。可用同一条回复重试，不会创建重复成果。');}
 }
 const latest=(kind:string)=>versions.filter(v=>v.kind===kind).reduce((n,v)=>Math.max(n,v.version),0);
 const currentScript=versions.filter(v=>v.kind==='script'&&v.status==='final').sort((a,b)=>b.version-a.version)[0]??null;
 const videoSourceExecution=useMemo(()=>{
  const byId=new Map(versions.filter(version=>version.kind==='script').map(version=>[version.id,version]));
  let cursor:ContentVersion|null=currentScript;
  const visited=new Set<string>();
  // Manual revisions retain their admitted ancestor; chain length is not a validity limit.
  while(cursor){
   if(visited.has(cursor.id))return null;
   visited.add(cursor.id);
   if(cursor.executionId)return cursor.executionId;
   cursor=cursor.sourceContentId?byId.get(cursor.sourceContentId)??null:null;
  }
  return null;
 },[currentScript,versions]);
 const currentStoryboard=Boolean(currentScript&&versions.some(v=>v.kind==='storyboard'&&v.sourceContentId===currentScript.id));
 const currentEditing=Boolean(currentScript&&versions.some(v=>v.kind==='editing'&&v.sourceContentId===currentScript.id));
 const videoPromptEnded=Boolean(currentScript&&typeof window!=='undefined'&&localStorage.getItem('opc-video-ended:'+currentScript.id));

 async function open(){setError('');try{
  const url=new URL(location.href),requestId=url.searchParams.get('start')??crypto.randomUUID();url.search='';url.searchParams.set('start',requestId);history.replaceState(null,'',url);
  const result=await start.mutateAsync({requestId,scope:{kind:'positioning_draft'}});
  if(!alive.current)return;
  if(requestedModule){localStorage.setItem('opc-runtime-skill:'+result.sessionId,requestedModule);setStoredModule(requestedModule);}
  url.search='';url.searchParams.set('session',result.sessionId);history.replaceState(null,'',url);setSession(result.sessionId);
 }catch{setError('建立草稿失败。再次点击会恢复同一次开始请求。');}}
 function requestedVideoChoice(value:string):VideoChoice|'end'|null{const text=value.trim().replace(/[。.!！?？]/g,'');if(/^(暂时结束|先结束|先到这里|暂时不生成)$/.test(text))return'end';if(/^(先做分镜[，,、\s]*再生成剪辑建议|分镜\s*[+＋和与、]\s*剪辑建议都生成|都生成|生成分镜和剪辑建议)$/.test(text))return'both';if(/^(只生成分镜|仅生成分镜|生成分镜)$/.test(text))return'storyboard';if(/^(只生成剪辑建议|仅生成剪辑建议|生成剪辑建议)$/.test(text))return'editing';return null;}
 async function send(scriptRequest=false){if(!workContextReady||!choices.data){setError('正在核对原工作与可用能力，请稍候；输入已保留。');return;}if(scriptRequest&&!isVideo)return;const videoChoice=isVideo&&currentScript?requestedVideoChoice(input):null;if(videoChoice){await chooseVideo(videoChoice);return;}setError('');
  // UI-A fix: the box empties on send; a send that is not stored puts the text back (unless the user typed again).
  let restoreInput=()=>{},stored=false;
  try{
  const chosen=choices.data?.skills.find(s=>'skill:'+s.moduleId===activeSelection);
  const selected=chosen?{kind:'skill' as const,moduleId:chosen.moduleId,revisionId:chosen.revisionId}:activeSelection.startsWith('auto:')?{kind:'auto' as const,modelId:activeSelection.slice(5)}:{kind:'ordinary' as const,modelId:activeSelection};
  const submitted=input,sent=COMPOSER_REFERENCES_ENABLED?referencesNamedIn(input,references):[];
  const requestInput=scriptRequest?'[OPC_SCRIPT_V1] 请基于当前选题简报讨论并给出可修改的口播稿。'+(submitted.trim()||'先给我一版口播稿。'):submitted;
  // An unconfirmed earlier send of the same input keeps its request id, so the server replays instead of charging twice.
  const url=new URL(location.href),requestId=requestIdFor(url.searchParams.get('request'),readPending(localStorage,sessionId),requestInput,undefined,sent);
  url.searchParams.set('request',requestId);history.replaceState(null,'',url);
  if(!scriptRequest)setOutgoing({text:submitted});
  // The box and the saved draft empty now; the sent text is kept in its own record until the server settles it.
  rememberPending(localStorage,sessionId,{requestId,text:submitted,input:requestInput,references:sent});
  const restoreText=clearForSend(setInput,submitted,text=>{localStorage.setItem('opc-runtime-input:'+sessionId,text);
   markPendingRestored(localStorage,sessionId);});
  setReferences([]);
  // The sent references come back with the text, before any added since.
  restoreInput=()=>{restoreText();setReferences(current=>{const next=mergeReferences(sent,current);
   saveDraftReferences(localStorage,sessionId,next);return next;});};
  const admitted=await prepare.mutateAsync({sessionId,requestId,input:requestInput,selection:selected,network:'deny',sources:[],
   ...(sent.length?{references:referenceRequest(sent)}:{})});
  if(!alive.current)return;
  // Q1: the previous organizer answered instead; this message was not stored. Input and request id stay.
  // A definite refusal: nothing was stored, so the record can go.
  if(!payg.admitted(admitted)){setOutgoing(null);restoreInput();forgetPending(localStorage,sessionId);await view.refetch();return;}
  stored=true;setOutgoing(old=>old&&{...old,executionId:admitted.executionId});
  void utils.opc.conversations.invalidate();
  sessionStorage.removeItem('opc-runtime-send:'+sessionId);
  url.searchParams.delete('request');history.replaceState(null,'',url);
  forgetPending(localStorage,sessionId);
  const executed=await runner.run(admitted.executionId);
  if(alive.current){if('unavailable' in executed&&executed.unavailable==='capacity'){markCapacity(admitted.executionId);setError('本次必要材料超过模型输入容量。原请求和已完成内容已保留；请点“停止”后缩短材料再发送。');}await Promise.all([view.refetch(),utils.opc.conversations.invalidate()]);}
 }catch(cause){if(!alive.current)return;const gate=runtimeAdmissionNotice(cause);
  setOutgoing(old=>old?.executionId?old:null); // Not confirmed: the text goes back into the box.
  // The outcome may be unknown (reply lost), so the record and request id stay for a replaying resend.
  if(!stored)restoreInput();
  // A referenced document was deleted mid-turn: the turn says so itself (runtimeTurnNotices).
  if(isLibrarySourceDeleted(cause)){await view.refetch();return;}
  // A stale, missing or unready reference: re-read the picker's lists so choosing again offers the current version.
  if(libraryReferenceRefusal(cause))void utils.library.invalidate();
  if(isOrganizerPendingError(cause)){payg.block();await view.refetch();return;}
  // A definite refusal of an unstored send says so; the same text keeps its request id and can be sent again.
  setError(gate??(stored?null:definiteRefusalNotice(cause,['runtime.prepare']))??'请求状态待核实。请读取原任务状态，不要重新发送相同内容。');await view.refetch();}}
 const initialSend=useRef(false);
 useEffect(()=>{
  if(initialSend.current||!sessionId||!input.trim()||!workContextReady||!choices.data||!activeSelection||busy)return;
  const requestId=sessionStorage.getItem('opc-runtime-send:'+sessionId);
  if(!requestId||new URL(location.href).searchParams.get('request')!==requestId)return;
  // The marker records one explicit send on the start page, never mere navigation. Consume it on
  // this attempt: whatever the outcome, input and request id stay, and any later send is the user's.
  initialSend.current=true;sessionStorage.removeItem('opc-runtime-send:'+sessionId);void send();
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[sessionId,input,workContextReady,choices.data,activeSelection,busy]);
 const videoKey=sessionId?'opc-video-operation:'+sessionId:'';
 const scriptKey=sessionId?(isVideo?'opc-script-final:':'opc-written-final:')+sessionId:'';
 const videoAttempt=useRef(false);
 const scriptAttempt=useRef(new Set<string>());
 function storeVideo(op:VideoOperation){localStorage.setItem(videoKey,JSON.stringify(op));}
 async function runVideo(initial:VideoOperation){
  if(!videoKey||videoBusy)return;setVideoBusy(true);setError('');
  let active=initial;
  try{await navigator.locks.request(videoKey,async()=>{
   const frozen=localStorage.getItem(videoKey);const recovering=Boolean(frozen);const op:VideoOperation=frozen?JSON.parse(frozen):initial;active=op;
   delete op.held; // Running it now is the explicit retry; a later failure decides again.
   if(op.workItemId!==workItem?.workItemId)throw new Error('OPC_REQUEST_CONFLICT');
   const refreshed=await library.refetch();
   if(!refreshed.data)throw new Error('OPC_CONTENT_PENDING');
   const freshItem=refreshed.data.businesses
    .flatMap((business:{accounts:Array<{items:Array<{workItemId:string;content:ContentVersion[]}>}>})=>business.accounts.flatMap(account=>account.items))
    .find((item:{workItemId:string})=>item.workItemId===op.workItemId);
   if(!freshItem)throw new Error('OPC_CONTENT_DENIED');
   const freshVersions=freshItem.content as ContentVersion[];
   const latestFinalScript=freshVersions.filter(version=>version.kind==='script'&&version.status==='final').sort((a,b)=>b.version-a.version)[0];
   if(!recovering&&op.sourceScriptId&&latestFinalScript?.id!==op.sourceScriptId)throw new Error('OPC_CONTENT_SOURCE');
   const requestedKinds=(op.choice??'both')==='both'?['storyboard','editing']:(op.choice==='storyboard'?['storyboard']:['editing']);
   const existing=freshVersions.filter(version=>requestedKinds.includes(version.kind)&&version.sourceContentId===op.sourceScriptId);
   if(existing.length===requestedKinds.length&&existing.every(version=>version.requestId===op.package.requestId)){
    localStorage.setItem(videoKey+':completed:'+op.package.requestId,JSON.stringify(op));localStorage.removeItem(videoKey);await view.refetch();return;
   }
   if(existing.length)throw new Error('OPC_CONTENT_ALREADY_GENERATED');
   const latestFresh=(kind:string)=>freshVersions.filter(version=>version.kind===kind).reduce((n,version)=>Math.max(n,version.version),0);
   if(!recovering&&(latestFresh('storyboard')!==op.package.expectedStoryboardVersion||latestFresh('editing')!==op.package.expectedEditingVersion))throw new Error('OPC_VERSION_CONFLICT');
   storeVideo(op);
   if(!op.sourceScriptId){const script=await saveContent.mutateAsync({workItemId:op.workItemId,requestId:op.script.requestId,expectedVersion:op.script.expectedVersion,kind:'script',status:'final',executionId:op.script.executionId,sourceContentId:null});op.sourceScriptId=script.id;storeVideo(op);await library.refetch();}
   const sourceScriptId=op.sourceScriptId;if(!sourceScriptId)throw new Error('OPC_CONTENT_PENDING');
   await prepareVideoMaterial.mutateAsync({workItemId:op.workItemId,requestId:op.followup.requestId,sourceScriptId,choice:op.choice??'both',expectedStoryboardVersion:op.package.expectedStoryboardVersion,expectedEditingVersion:op.package.expectedEditingVersion});
   let packageExecutionId=op.followup.executionId;
   if(!packageExecutionId){const admitted=await prepare.mutateAsync({sessionId,requestId:op.followup.requestId,input:op.followup.input,selection:op.followup.selection,network:'deny',sources:[]});packageExecutionId=admitted.executionId;op.followup.executionId=packageExecutionId;storeVideo(op);}
   if(!packageExecutionId)throw new Error('OPC_CONTENT_PENDING');
   await checkVideo.mutateAsync({workItemId:op.workItemId,executionId:packageExecutionId,sourceScriptId});
   const executed=await runner.run(packageExecutionId);
   const gateError=videoGateError(executed);if(gateError)throw gateError;
   if('unavailable' in executed&&executed.unavailable==='capacity')throw new Error('OPC_CONTENT_CAPACITY');
   if('unavailable' in executed&&executed.unavailable==='output_truncated')throw new Error(executed.state==='cancelled'?'OPC_CONTENT_OUTPUT_TRUNCATED':'OPC_CONTENT_OUTPUT_TRUNCATED_PENDING');
   if(executed.state==='cancelled')throw new Error('OPC_CONTENT_DENIED');
   if(executed.state!=='completed')throw new Error('OPC_CONTENT_PENDING');
   await saveResults.mutateAsync({workItemId:op.workItemId,requestId:op.package.requestId,executionId:packageExecutionId,sourceScriptId,expectedStoryboardVersion:op.package.expectedStoryboardVersion,expectedEditingVersion:op.package.expectedEditingVersion,choice:op.choice??'both'});
   localStorage.setItem(videoKey+':completed:'+op.package.requestId,JSON.stringify(op));localStorage.removeItem(videoKey);const rejectedPackage=localStorage.getItem(videoKey+':rejected-source:'+op.script.executionId);if(rejectedPackage)localStorage.removeItem(videoKey+':rejected:'+rejectedPackage);localStorage.removeItem(videoKey+':rejected-source:'+op.script.executionId);await Promise.all([view.refetch(),library.refetch()]);
  });}catch(cause){const message=cause instanceof Error?cause.message:'';const admissionGate=runtimeAdmissionNotice(cause);
  // Only a definite admission refusal followed by a successful abandon proves the material claim is gone. Any other
  // refusal (for example material replay refused by policy or sign-in) says nothing about an earlier claim: hold it.
  const refused=definiteRefusal(cause);let released=false;
  if(refused?.path==='runtime.prepare'&&!active.followup.executionId&&localStorage.getItem(videoKey)){
   if(active.sourceScriptId)try{await prepareVideoMaterial.mutateAsync({action:'abandon',workItemId:active.workItemId,
    requestId:active.followup.requestId,sourceScriptId:active.sourceScriptId,choice:active.choice??'both',
    expectedStoryboardVersion:active.package.expectedStoryboardVersion,expectedEditingVersion:active.package.expectedEditingVersion});
    released=true;}catch{/* Outcome unknown: keep the claim and the request for an explicit retry. */}
  }
  // Every other failure before admission may have been processed (any 503, lost response, failed release): keep the
  // frozen material and request id for an explicit retry. Never abandon it or resume it automatically after a reload.
  if(!released&&!active.followup.executionId&&!videoDefiniteRejections.has(message)){
   const frozen=localStorage.getItem(videoKey);if(frozen)storeVideo({...JSON.parse(frozen),...active,held:true});
   const kept='完整原请求已保留；条件恢复后再次选择，会用同一请求继续，不会新建请求。';
   // A structured refusal carries a fixed server notice (for example "please sign in again"); never raw diagnostics.
   const refusedNotice=refused&&refused.path!=='runtime.prepare'&&cause instanceof Error?cause.message+' '+kept:null;
   setError(!frozen?'视频工作请求未发出，请稍后再选择一次。':admissionGate??refusedNotice??'视频工作请求状态待核实。'+kept);return;
  }
  const gateNotice=videoGateNotice(message);
  let definite=released||videoDefiniteRejections.has(message)||videoGateNotice(message)!==null;if(message==='OPC_CONTENT_BINDING'&&active.followup.executionId)try{await cancel.mutateAsync({executionId:active.followup.executionId});await view.refetch();}catch{definite=false;}if(message==='OPC_CONTENT_OUTPUT_TRUNCATED_PENDING'){setError('本次模型调用达到长度上限，未返回该阶段正文。已生成内容和原请求已保留，不会自动重试。');await view.refetch();}else if(definite){localStorage.setItem(videoKey+':rejected:'+active.package.requestId,JSON.stringify(active));localStorage.setItem(videoKey+':rejected-source:'+active.script.executionId,active.package.requestId);localStorage.removeItem(videoKey);await view.refetch();setError(gateNotice??(message==='OPC_CONTENT_OUTPUT_TRUNCATED'?OUTPUT_TRUNCATED_NOTICE:message==='OPC_CONTENT_RESPONSE_INVALID'?'分镜回复格式未通过保存校验，口播稿定稿已保留；请在原对话要求 Agent 重新整理。':'原视频工作请求已明确拒绝（'+message+'），没有再次派发。请刷新后基于最新版本重试。'));}else if(message==='OPC_CONTENT_CAPACITY'){if(active.followup.executionId)markCapacity(active.followup.executionId);setError('分镜或剪辑所需材料超过模型输入容量。原请求与口播稿已保留；请点“停止”后缩短材料再继续。');}else setError(gateNotice??'视频工作请求状态待核实。完整原请求已保留；再次点击只会恢复这一次请求。');}finally{setVideoBusy(false);}
 }
 async function finalizeScript(executionId:string,recoveryKey?:string){const key=recoveryKey??scriptKey;if(!workItem||!key)return;setVideoBusy(true);setError('');try{await navigator.locks.request(key,async()=>{const frozen=localStorage.getItem(key);const op:ScriptOperation=frozen?JSON.parse(frozen):{kind:isVideo?'script':'brief',workItemId:workItem.workItemId,requestId:executionId,executionId,expectedVersion:latest(isVideo?'script':'brief')};if(op.workItemId!==workItem.workItemId)throw new Error('OPC_REQUEST_CONFLICT');localStorage.setItem(key,JSON.stringify(op));await saveContent.mutateAsync({workItemId:op.workItemId,requestId:op.requestId,expectedVersion:op.expectedVersion,kind:op.kind??'script',status:(op.kind??'script')==='script'?'final':'draft',executionId:op.executionId,sourceContentId:null});localStorage.setItem(key+':completed:'+op.requestId,JSON.stringify(op));localStorage.removeItem(key);await library.refetch();setVideoUiRevision(v=>v+1);});}catch(cause){const message=cause instanceof Error?cause.message:'';if(scriptDefiniteRejections.has(message)){localStorage.setItem(key+':rejected:'+executionId,localStorage.getItem(key)??'');localStorage.removeItem(key);setError('采用请求已明确拒绝（'+message+'），请刷新后核对最新版本。');}else setError('采用结果待核实。完整原请求已保留；再次点击只会恢复这一次请求。');}finally{setVideoBusy(false);}}
 async function chooseVideo(choice:VideoChoice|'end'){if(!isVideo||!currentScript||!workItem||!choices.data)return;if(choice==='end'){localStorage.setItem('opc-video-ended:'+currentScript.id,'true');setVideoUiRevision(v=>v+1);setError('');return;}if(choice==='editing'&&!currentStoryboard){setError('请先完成这版口播稿的分镜，再基于分镜生成剪辑建议。');return;}if(!videoSourceExecution){setError('这版口播稿缺少可恢复的来源，暂不能继续生成。');return;}if((choice==='both'&&(currentStoryboard||currentEditing))||(choice==='storyboard'&&currentStoryboard)||(choice==='editing'&&currentEditing)){setError('这版口播稿对应的所选成果已经生成，请在下方查看。');return;}const frozen=videoKey?localStorage.getItem(videoKey):null;if(frozen){await runVideo(JSON.parse(frozen));return;}const skill=choices.data.skills.find(s=>'skill:'+s.moduleId===activeSelection);const selection=skill?{kind:'skill' as const,moduleId:skill.moduleId,revisionId:skill.revisionId}:null;if(!selection){setError('请选择当前选题可用的 Skill，再继续生成。');return;}const requestId=crypto.randomUUID();const requested=choice==='both'?'生成分镜脚本和剪辑建议':choice==='storyboard'?'只生成分镜脚本':'只生成剪辑建议';const fields=choice==='both'?'storyboard 与 editing 两个字符串字段':choice==='storyboard'?'storyboard 一个字符串字段':'editing 一个字符串字段';const op:VideoOperation={workItemId:workItem.workItemId,choice,script:{requestId:currentScript.requestId,executionId:videoSourceExecution,expectedVersion:currentScript.version-1},sourceScriptId:currentScript.id,followup:{requestId,input:`[OPC_VIDEO_PACKAGE_V1] 用户已明确同意：基于资料中已定稿的口播稿，${requested}。遵循当前 Skill 的创作方法：剪辑建议必须基于匹配当前口播稿的分镜；仅剪辑时必须依据资料中已保存的分镜，不得跳过分镜或自行补造。只返回严格 JSON 对象，且只含 ${fields}；不要生成图片、视频或执行发布。`,selection},package:{requestId,expectedStoryboardVersion:latest('storyboard'),expectedEditingVersion:latest('editing')}};await runVideo(op);}
 useEffect(()=>{if(!videoKey||videoAttempt.current||!workItem||!view.data)return;const raw=localStorage.getItem(videoKey);if(!raw)return;const op:VideoOperation=JSON.parse(raw);if(op.held)return;videoAttempt.current=true;void runVideo(op);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[videoKey,workItem?.workItemId,view.data]);
 useEffect(()=>{if(!sessionId||!workItem||!view.data||videoBusy)return;for(const key of ['opc-script-final:'+sessionId,'opc-written-final:'+sessionId]){const raw=localStorage.getItem(key);if(!raw||scriptAttempt.current.has(key))continue;scriptAttempt.current.add(key);const op:ScriptOperation=JSON.parse(raw);void finalizeScript(op.executionId,key);break;}
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[sessionId,workItem?.workItemId,view.data,videoBusy]);

 async function stop(executionId:string){setError('');setUserStops(ids=>ids.includes(executionId)?ids:[...ids,executionId]);
  const request=runner.freeze(executionId);const at={storage:browserSession(),sessionId,executionId};
  if(await stopWithRecord(at,()=>cancel.mutateAsync(request??{executionId}),()=>view.refetch())){setError('取消状态待核实，请读取原任务。');
   setUserStops(userStopIds(at.storage,sessionId,executions??[]));}}
 async function recover(executionId:string){setError('');try{const executed=await runner.run(executionId);if('unavailable' in executed&&executed.unavailable==='capacity'){markCapacity(executionId);setError('原请求的必要材料超过模型输入容量，无法继续发送。已有内容已保留；请点“停止”后缩短材料再发送。');}await view.refetch();}
  catch(cause){if(isLibrarySourceDeleted(cause)){await view.refetch();return;}setError('暂时无法恢复，请保留原任务。');}}
 // FUSION-COMPARE: first version only on free conversations (no work item), Owner 2026-10-17 Q3.
 // The compare asks for exactly the selection the composer would send: until the choices are loaded and a chosen Skill resolves,
 // it stays disabled instead of silently falling back to a no-Skill comparison (the user would pay for a different prompt).
 const compareChoice=choices.data?.skills.find(x=>'skill:'+x.moduleId===activeSelection);
 const compareSkill={ready:Boolean(choices.data&&activeSelection&&(!activeSelection.startsWith('skill:')||compareChoice)),
  skill:compareChoice?{kind:'skill' as const,moduleId:compareChoice.moduleId,revisionId:compareChoice.revisionId}:undefined};
 // Listed as soon as the session id is known (not after the view: the list answers [] for a conversation without compares), so
 // the cards and the adoption markers arrive together with the history instead of seconds later.
 const compare=useCompareThread(sessionId||null);
 // An adopted answer is a cancelled turn that must not read as failed. Until the list has answered it is unknown which are, so only the
 // generic "ended" line waits (stop, capacity, refusal and rate-limit notices come from their own causes and stay).
 const compareNotices=(e:RuntimeTurn)=>turnNotices(e).filter(n=>!(freeChat&&!compare.loaded&&n.text===ENDED_NOTICE));
 const executions=view.data?.executions as Array<{executionId:string;createdAt?:string;state:string;input:string|null;body:string|null;primaryBody:string|null;organizerComplete:boolean|null;skillExecution:boolean;needsTask:boolean;unavailableReason:string|null;historyOmitted?:boolean;contentAvailable:boolean;userStopPending?:boolean;stopped?:boolean;
  billing?:{pausedReason?:string|null;cancelRequested?:boolean}|null;cursor?:number|null;epoch?:number|null;remainingCalls?:number|null}>|undefined;
 const capacitySignature=executions?.map(e=>e.executionId+':'+e.state).join('|');
 useEffect(()=>{setGateStops(gateStopNotices(browserSession(),sessionId,executions??[]));setUserStops(userStopIds(browserSession(),sessionId,executions??[]));
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[sessionId,capacitySignature]);
 useEffect(()=>{const ids:string[]=[];for(const e of executions??[]){const key=capacityKey(e.executionId);if(e.state==='completed'||e.state==='cancelled'){try{sessionStorage.removeItem(key);}catch{/* No local marker to remove. */}}else try{if(sessionStorage.getItem(key)==='1')ids.push(e.executionId);}catch{/* Current request can still show the alert. */}}setCapacityIds(current=>current.join('|')===ids.join('|')?current:ids);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[sessionId,capacitySignature]);
 useEffect(()=>{
  const node=scrollArea.current;if(!node)return;
  const align=()=>node.parentElement?.style.setProperty('--chat-scrollbar-space',((node.offsetWidth-node.clientWidth)/2)+'px');
  align();const observer=new ResizeObserver(align);observer.observe(node);return()=>observer.disconnect();
 },[]);
 const turnsSignature=transcriptSignature(executions?.map(item=>[item.executionId,item.state,item.body,item.primaryBody].join(':')).join('|'),outgoing);
 // Streamed text grows without any view change; it moves the transcript too (only while following the bottom).
 const scrollSignature=turnsSignature===undefined?undefined:turnsSignature+liveScrollSignature(runner.reply);
 useEffect(()=>{
  const node=scrollArea.current;if(!node||!scrollKey||scrollSignature===undefined)return;
  scrollState.current=followTranscript(node,scrollState.current,scrollKey,scrollSignature,()=>{
   try{return sessionStorage.getItem(scrollKey);}catch{return null; /* First entry uses the latest messages. */}
  });
 },[scrollKey,scrollSignature]);
 async function guide(){
  if(!workItem||!choices.data?.defaultSkill||!sessionId||contentType==='unknown')return;
  const stage=versions.at(-1)?.id??workItem.workItemId;
  const key='opc-work-guide:'+sessionId+':'+stage;
  const request={sessionId,requestId:stage,input:'[OPC_WORK_CONTINUE_V1] 工作阶段 '+stage+'。用户选择继续这条'+typeLabel[contentType]+'选题。请遵循当前Skill，结合现有简报、对话与已保存成果，判断当前进度与适合的讨论方式。不要直接生成正文或口播稿，不要生成分镜、剪辑、图片、视频或发布；已定稿后只询问下一步意愿。',selection:{kind:'skill' as const,moduleId:choices.data.defaultSkill.moduleId,revisionId:choices.data.defaultSkill.revisionId},network:'deny' as const,sources:[]};
  if(executions?.some(e=>e.input?.startsWith('[OPC_WORK_CONTINUE_V1] 工作阶段 '+stage+'。')))return;
  setGuiding(true);setError('');
  try{await navigator.locks.request(key,async()=>{const raw=localStorage.getItem(key);const frozen=raw?JSON.parse(raw):request;localStorage.setItem(key,JSON.stringify(frozen));const admitted=await prepare.mutateAsync(frozen);const executed=await runner.run(admitted.executionId);if('unavailable' in executed&&executed.unavailable==='capacity'){markCapacity(admitted.executionId);setError('引导请求的必要材料超过模型输入容量，原请求已保留；请点“停止”后缩短材料再发送。');}await view.refetch();});}
  catch(cause){
   // A definite 4xx refusal ends this guidance request; keep its record but drop the recovery control.
   if(definiteRefusal(cause)){try{localStorage.setItem(key+':rejected',localStorage.getItem(key)??'');localStorage.removeItem(key);}
    catch{/* Without storage there is nothing to recover. */}setError('引导请求已明确拒绝（'+(cause as Error).message+'），没有再次派发。');}
   else setError(runtimeAdmissionNotice(cause)??GUIDE_HELD_NOTICE);
  }
  finally{setGuiding(false);}
 }
 // A frozen guidance request without its execution waits for the user's explicit recovery.
 const guideStage=versions.at(-1)?.id??workItem?.workItemId??'';
 const guideDone=Boolean(executions?.some(e=>e.input?.startsWith('[OPC_WORK_CONTINUE_V1] 工作阶段 '+guideStage+'。')));
 const [heldGuide,setHeldGuide]=useState(false);
 useEffect(()=>{let held=false;try{held=Boolean(sessionId&&guideStage&&localStorage.getItem('opc-work-guide:'+sessionId+':'+guideStage));}
  catch{/* Without storage there is no frozen request to recover. */}setHeldGuide(held&&!guideDone&&!guiding);},[sessionId,guideStage,guideDone,guiding]);
 useEffect(()=>{if(guidanceAttempt.current||!workItem||!view.data||!choices.data?.defaultSkill||contentType==='unknown'||view.data.activeExecution||videoBusy||Boolean(localStorage.getItem(videoKey))||Boolean(localStorage.getItem(scriptKey))||!new URL(location.href).searchParams.has('continue'))return;guidanceAttempt.current=true;
 // Consume the one automatic start before sending: a refused or reloaded guidance never sends itself again.
 const url=new URL(location.href);url.searchParams.delete('continue');history.replaceState(null,'',url);void guide();
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[workItem,view.data,choices.data,contentType,videoBusy]);
 const turnNotices=(e:RuntimeTurn)=>runtimeTurnNotices(e,{busy,capacity:capacityIds.includes(e.executionId),gateStop:gateStops[e.executionId],
  userStopped:userStops.includes(e.executionId),finished:finishedExecution(runner.call,view)===e.executionId,
  sourceDeleted:runner.sourceDeleted.includes(e.executionId),
  stopping:cancel.isPending,onRetry:()=>void recover(e.executionId),onStop:()=>void stop(e.executionId)});
 const lastExecution=executions?.at(-1);
 const lastTurn=lastExecution&&{open:isOpenTurn(lastExecution.state),texts:turnNotices(lastExecution).map(notice=>String(notice.text))};
 const pendingOutgoing=outgoing&&!executions?.some(e=>e.executionId===outgoing.executionId)?outgoing:null;
 async function setType(value:string){if(!workItem)return;const key='opc-content-type:'+workItem.workItemId;try{await navigator.locks.request(key,async()=>{const raw=localStorage.getItem(key);const frozen=raw?JSON.parse(raw):{requestId:crypto.randomUUID(),target:'item' as const,targetId:workItem.workItemId,expectedRevision:workItem.revision,patch:{title:workItem.title,brief:workItem.brief??'',day:workItem.day,contentType:value}};localStorage.setItem(key,JSON.stringify(frozen));setTypePending(true);await editItem.mutateAsync(frozen);localStorage.removeItem(key);setTypePending(false);await library.refetch();});}catch(cause){const code=cause instanceof Error?cause.message:'';if(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_DENIED','OPC_LIBRARY_INVALID'].includes(code)){localStorage.setItem(key+':rejected',localStorage.getItem(key)??'');localStorage.removeItem(key);setTypePending(false);await library.refetch();setError('类型保存已明确拒绝，已读取当前版本，请重新确认。');}else setError('类型保存状态待核实；再次选择会恢复原请求，不会覆盖为另一类型。');}}

 return <WorkspaceFrame area="chat" revealRight={revealResults}
  activeWorkItemId={workItem?.workItemId} notice={choices.data?.mode==='staging_test'?'Staging 真实对话测试 · 消耗测试预算':choices.data?.mode==='isolated'?'本地隔离 · 模型回复为模拟，保存写入本地测试服务':undefined} rightOpen={panelOpen} onToggleRight={()=>setPanelOpen(value=>!value)} right={workItem?(contentType==='unknown'?<RuntimeTypePendingPanel/>:<ContentEditor key={workItem.workItemId+':'+contentType} item={workItem} onSaved={()=>library.refetch()}><RuntimeResultsSection isVideo={isVideo} versions={versions}
  currentScriptId={currentScript?.id} saved={saved.data} libraryHref={'/app/library?item='+workItem.workItemId+'&return='+sessionId}/></ContentEditor>)
  :results.data?.length?<SessionResultsPanel sessionId={sessionId} items={results.data}/>:undefined}><main className={`${workStyles.conversation} flex h-full min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]`}>
  <RuntimeHeader title={workItem?.title??'工作对话'}
   subtitle={workItem?undefined:runtimeModeSubtitle(choices.data?.mode??view.data?.mode)}
   meta={workItem?{platform:workItem.platform,account:workItem.account,infoHref:'/app/library?item='+workItem.workItemId+'&return='+sessionId,
    showExpand:!panelOpen,onExpand:()=>setPanelOpen(true)}:undefined}
   action={!sessionId&&requestedModule?<Button variant="outline" disabled={busy||!choices.data||Boolean(input.trim())||Boolean(requestedModule&&!chosenModule)}
    onClick={open}><Plus className="mr-2 h-4 w-4"/>用此功能准备新任务</Button>
    // A closed results folder of a free chat reopens here (the frame's own reopen button is mobile-only).
    :!workItem&&!panelOpen&&results.data?.length?<Button variant="outline" onClick={()=>setPanelOpen(true)}>展开成果夹</Button>:null}/>
  {requestedModule&&!chosenModule&&<p className="shrink-0 px-6 py-1 text-center text-[11px] text-[var(--text-tertiary)]">所选功能当前不满足本地工作区准入条件；不会自动换用其他功能。</p>}
  <QueryNotice error={choices.error||view.error||library.error||results.error} label="当前工作" retry={()=>Promise.all([choices.refetch(),...(sessionId?[view.refetch()]:[]),...(sessionId&&view.data?.scope?.kind==='work_item'?[library.refetch()]:[]),...(freeChat?[results.refetch()]:[])])}/>
  <div ref={scrollArea} onScroll={rememberScroll} className={workStyles.scrollArea} aria-label="对话记录">
   {!executions?.length&&<RuntimeEmptyState
    text={workItem?'已带入选题简报和原工作方法，正在根据当前进度准备引导。':sessionId?'输入一条消息，发送后可刷新查看记录。':'从左侧“新对话”开始。'}/>}
   <section className={workStyles.transcript}>
    {workItem&&typePending&&<ChatInlineNotice tone="warning" label="类型保存待核实"
     actions={[{label:CHAT_ACTION.retry,disabled:editItem.isPending,onClick:()=>void setType('unknown')}]}>内容类型保存结果待核实。</ChatInlineNotice>}
    {workItem&&contentType==='unknown'&&<section className="rounded-xl border p-4" aria-label="确认内容类型"><h2>这条选题准备做成什么内容？</h2><p>先确认形式，再一起细化重点和结构。</p><div className="flex gap-2 mt-3">{['article','image_text','video'].map(value=><Button key={value} disabled={busy||editItem.isPending||typePending} onClick={()=>setType(value)}>{typeLabel[value]}</Button>)}</div></section>}{(()=>{const placed=placeCompareCards(compare.cards,executions);const cardsAt=(at:number)=>placed.get(at)?<CompareThread cards={placed.get(at)!} names={compare.names}
     onAdopted={()=>{void compare.refresh();void view.refetch();}} onQuote={text=>updateInput(text)}/>:null;
    return <>{cardsAt(-1)}{executions?.map((e,index)=><Fragment key={e.executionId}><RuntimeTurnView
    dateLabel={e.createdAt&&(index===0||!executions[index-1].createdAt||transcriptDay(executions[index-1].createdAt!)!==transcriptDay(e.createdAt))
     ?transcriptDate(e.createdAt):null}
    userText={e.input&&!e.input.startsWith('[OPC_WORK_CONTINUE_V1]')?shownRuntimeInput(e.input):null}
    completed={e.skillExecution&&e.state==='completed'&&!e.input?.startsWith('[OPC_WORK_CONTINUE_V1]')&&!e.input?.startsWith('[OPC_VIDEO_PACKAGE_V1]')}>
     <AgentWorkStatus items={runner.sourceDeleted.includes(e.executionId)?[]:streamedWorkItems(e,runner.workItems?.[e.executionId])}/>
     {(()=>{const progress=runtimeTurnProgress({turnState:e.state,reply:runner.reply,executionId:e.executionId,streaming:runner.streaming,
       savedReply:Boolean(e.primaryBody||e.body),items:streamedWorkItems(e,runner.workItems?.[e.executionId])});
      return progress&&<TurnSteps hideTools quiet={progress.reopened} progress={progress.input}/>;})()}
     {workItem&&e.skillExecution&&e.state==='completed'&&!e.input?.startsWith('[OPC_WORK_CONTINUE_V1]')&&!e.input?.startsWith('[OPC_VIDEO_PACKAGE_V1]')&&e.contentAvailable?<RuntimeProposal adopted={versions.some(v=>v.kind===(isVideo?'script':'brief')&&v.executionId===e.executionId)}
      text={displayReply(e.input,e.body??e.primaryBody)}/>:!liveReplyText(runner.reply,e.executionId,e)&&showsReply(e)&&<RuntimeReply available={e.contentAvailable} text={displayReply(e.input,e.body??e.primaryBody)}/>}
     {workItem&&contentType!=='unknown'&&e.state==='completed'&&e.skillExecution&&!e.input?.startsWith('[OPC_VIDEO_PACKAGE_V1]')&&!e.input?.startsWith('[OPC_WORK_CONTINUE_V1]')&&<div className="mt-3 flex flex-wrap gap-2">{versions.some(v=>v.kind===(isVideo?'script':'brief')&&v.executionId===e.executionId)?<Link className="underline" href={'/app/library?item='+workItem.workItemId+'&return='+sessionId}>{isVideo?'这版口播稿已定稿':'已采用为草稿'} · 查看</Link>:<Button disabled={busy} onClick={()=>finalizeScript(e.executionId)}>{isVideo?'将这条回复定稿为口播稿':'采用为当前草稿'}</Button>}</div>}
     {workItem&&contentType==='unknown'&&e.state==='completed'&&e.skillExecution&&e.contentAvailable&&!e.input?.startsWith('[OPC_WORK_CONTINUE_V1]')&&!e.input?.startsWith('[OPC_VIDEO_PACKAGE_V1]')&&<div className="mt-2">{saved.data?.find((result:{artifactId:string;version:number})=>result.artifactId===e.executionId)?<p role="status">已保存成果 · 第 {saved.data.find((result:{artifactId:string;version:number})=>result.artifactId===e.executionId)?.version} 版</p>:<Button variant="outline" disabled={saveWorkResult.isPending} onClick={()=>persistSkillResult(e.executionId)}>保存 Skill 成果</Button>}</div>}
     {/* Only a reply shown exactly as stored can be saved: the server keeps verbatim text, never a reformatted list. */}
     {freeChat&&results.data&&e.state==='completed'&&e.contentAvailable&&(e.body??e.primaryBody)&&
      displayReply(e.input,e.body??e.primaryBody)===(e.body??e.primaryBody)&&
      <SaveReplyButton sessionId={sessionId} executionId={e.executionId} reply={(e.body??e.primaryBody)!}
       onOpenResults={()=>{setPanelOpen(true);setRevealResults(count=>count+1);}}
       savedItems={results.data.filter(result=>result.sourceExecutionId===e.executionId)}/>}
     <LiveReplyText text={liveReplyText(runner.reply,e.executionId,e)}/>
     <ChatNoticeList notices={compare.adoptedExecutions.has(e.executionId)?[]:[...compareNotices(e),...withResumeStop(payg.turnNotices(e,busy),
      runner.streaming&&runner.reply?.executionId===e.executionId,{onClick:()=>void stop(e.executionId),disabled:cancel.isPending})]}/>
   </RuntimeTurnView>{cardsAt(index)}</Fragment>)}</>;})()}
   {isVideo&&currentScript&&videoPromptEnded&&(!currentStoryboard||!currentEditing)&&<Button variant="outline" onClick={()=>{localStorage.removeItem('opc-video-ended:'+currentScript.id);setVideoUiRevision(v=>v+1);}}>继续这版口播稿的分镜或剪辑</Button>}
   {isVideo&&currentScript&&!videoPromptEnded&&(!currentStoryboard||!currentEditing)&&<section aria-label="口播稿后续选择" className="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4"><h2 className="font-medium">{currentStoryboard?'分镜已保存。要基于这版分镜生成剪辑建议吗？':'口播稿已定稿。要先制作分镜脚本吗？'}</h2><p className="text-sm text-[var(--text-secondary)]">本次只绑定口播稿第 {currentScript.version} 版。选择后才会调用 Agent；以后重新定稿口播稿时不会自动生成。</p><div className="flex flex-wrap gap-2">{!currentStoryboard&&<Button disabled={busy||currentEditing} onClick={()=>chooseVideo('both')}>先做分镜，再生成剪辑建议</Button>}{!currentStoryboard&&<Button variant="outline" disabled={busy} onClick={()=>chooseVideo('storyboard')}>只生成分镜</Button>}{currentStoryboard&&<Button variant="outline" disabled={busy||currentEditing} onClick={()=>chooseVideo('editing')}>只生成剪辑建议</Button>}<Button variant="ghost" disabled={busy} onClick={()=>chooseVideo('end')}>暂时结束</Button></div><p className="text-xs text-[var(--text-tertiary)]">也可以在消息框输入同样的选择；提问卡和自然语言只执行同一个业务动作。</p></section>}
{pendingOutgoing&&<RuntimePendingMessage text={pendingOutgoing.text} sending={busy}/>}
{pendingOutgoing?.executionId&&!runner.sourceDeleted.includes(pendingOutgoing.executionId)&&
 <AgentWorkStatus items={runner.workItems?.[pendingOutgoing.executionId]??[]}/>}
{pendingOutgoing?.executionId&&!executions?.some(e=>e.executionId===pendingOutgoing.executionId)&&(()=>{
 const progress=runtimeTurnProgress({turnState:'running',reply:runner.reply,executionId:pendingOutgoing.executionId,streaming:runner.streaming,
  items:runner.workItems?.[pendingOutgoing.executionId]??[]});
 return progress&&<TurnSteps hideTools progress={progress.input}/>;})()}
{pendingOutgoing?.executionId&&<PendingLiveReply text={liveReplyText(runner.reply,pendingOutgoing.executionId)}/>}
   <ChatNoticeList notices={[...payg.blockedNotices(executions,busy),...runtimeTailNotices({error,heldGuide,busy,onGuide:()=>void guide(),lastTurn})]}/>
   </section>
  </div>
  {sessionId&&<footer className={`${composerStyles.zone} ${workStyles.composerZone}`}><div className={composerStyles.wrap}>
   {freeChat&&<CompareButton sessionId={sessionId} question={input}
    disabled={busy||Boolean(view.data?.activeExecution)||!compareSkill.ready}
    blockedReason={COMPOSER_REFERENCES_ENABLED&&referencesNamedIn(input,references).length?'带 @ 引用资料的消息暂时不能多模型对比，请去掉引用后再试。':undefined}
    skill={compareSkill.skill}
    onStarted={compareId=>{updateInput('');compare.add(compareId);void compare.refresh();}} onMaybeStarted={()=>void compare.refresh()}/>}
   {workItem&&isVideo&&<Button variant="outline" disabled={busy||Boolean(view.data?.activeExecution)||!choices.data?.defaultSkill} onClick={()=>send(true)}>{currentScript?'修改口播稿':'起草口播稿'}</Button>}
   <WorkComposer value={input} onChange={updateInput} onSend={()=>void send()}
    referenceList={references} onReferencesChange={updateReferences}
    sendDisabled={busy||Boolean(view.data?.activeExecution)||!workContextReady||!choices.data||!activeSelection} sessionId={sessionId} skillId={activeSelection.startsWith('skill:')?activeSelection.slice(6):''} onSkillChange={id=>{setSelection(id?'skill:'+id:ordinary);if(id)localStorage.setItem('opc-runtime-skill:'+sessionId,id);else localStorage.removeItem('opc-runtime-skill:'+sessionId);}} note={workItem?'本次讨论参考当前工作的最新成果。Enter 发送，Shift + Enter 换行。':'可以自由提问；Agent 按需查阅相关资料。Enter 发送，Shift + Enter 换行。'}/>
  </div></footer>}
 </main></WorkspaceFrame>;
}
