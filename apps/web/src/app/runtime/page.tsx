'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Suspense,useEffect,useState,useRef,useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { Bot,Plus,Loader2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { WorkComposer } from '@/components/opc/work-composer';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { ContentEditor } from '@/components/opc/content-editor';
import composerStyles from '@/components/opc/work-composer.module.css';
import workStyles from './runtime-work.module.css';
import { trpc } from '@/trpc/client';

type VideoChoice='both'|'storyboard'|'editing';
type VideoOperation={workItemId:string;choice?:VideoChoice;script:{requestId:string;executionId:string;expectedVersion:number};followup:{requestId:string;input:string;selection:{kind:'skill';moduleId:string;revisionId:string};executionId?:string};package:{requestId:string;expectedStoryboardVersion:number;expectedEditingVersion:number};sourceScriptId?:string};
type ScriptOperation={kind?:'brief'|'script';workItemId:string;requestId:string;executionId:string;expectedVersion:number};
type ContentVersion={id:string;kind:string;version:number;status:string;body:string|null;sourceContentId:string|null;executionId:string|null;requestId:string};
const videoDefiniteRejections=new Set(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_CONTENT_DENIED','OPC_CONTENT_BINDING','OPC_CONTENT_RESPONSE_INVALID','OPC_CONTENT_SOURCE','OPC_CONTENT_ALREADY_GENERATED','OPC_CONTENT_CHOICE_INVALID','OPC_STORYBOARD_REQUIRED','OPC_VIDEO_TYPE_REQUIRED']);
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
function transcriptDay(value:string){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
function transcriptDate(value:string){const day=transcriptDay(value),today=transcriptDay(new Date().toISOString());const time=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));return day===today?'今天 '+time:day.replaceAll('-','/')+' '+time;}

export default function RuntimePage(){return <Suspense fallback={<p>正在读取工作…</p>}><RuntimeRoute/></Suspense>}
function RuntimeRoute(){
 const params=useSearchParams();
 const routeSession=params.get('session')??'';
 const routeModule=params.get('module')??'';
 return <RuntimeWorkspace key={routeSession||'new:'+routeModule} routeSession={routeSession} routeModule={routeModule}/>;
}
function RuntimeWorkspace({routeSession,routeModule}:{routeSession:string;routeModule:string}){
 const utils=trpc.useUtils();
 const profile=trpc.user.getUserProfile.useQuery();
 const [sessionId,setSession]=useState(routeSession),[input,setInput]=useState(''),[selection,setSelection]=useState(''),[error,setError]=useState('');
 const [capacityIds,setCapacityIds]=useState<string[]>([]);
 const capacityKey=(executionId:string)=>'opc-runtime-capacity:'+sessionId+':'+executionId;
 function markCapacity(executionId:string){try{sessionStorage.setItem(capacityKey(executionId),'1');}catch{/* The current alert still explains the failure. */}setCapacityIds(ids=>ids.includes(executionId)?ids:[...ids,executionId]);}
 const [storedModule,setStoredModule]=useState('');
 const requestedModule=routeModule;
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(sessionId)setInput(localStorage.getItem('opc-runtime-input:'+sessionId)??'');},[sessionId]);
 useEffect(()=>{setStoredModule(sessionId?localStorage.getItem('opc-runtime-skill:'+sessionId)??'':'');},[sessionId]);
 function updateInput(value:string){setInput(value);if(sessionId)localStorage.setItem('opc-runtime-input:'+sessionId,value);}
 const choices=trpc.runtime.choices.useQuery(sessionId?{sessionId}:undefined);
 const view=trpc.runtime.view.useQuery({sessionId},{enabled:Boolean(sessionId),refetchInterval:5000});
 const saved=trpc.opc.workResults.useQuery({sessionId},{enabled:Boolean(sessionId&&view.data?.scope?.kind==='work_item')});
 const saveWorkResult=trpc.opc.saveWorkResult.useMutation();
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null},{enabled:Boolean(sessionId&&view.data?.scope?.kind==='work_item')});
 const [panelOpen,setPanelOpen]=useState(true),[guiding,setGuiding]=useState(false);
 const guidanceAttempt=useRef(false);
 const [typePending,setTypePending]=useState(false);
 const editItem=trpc.opc.editLibrary.useMutation();
 const saveContent=trpc.opc.saveContentResult.useMutation(),prepareVideoMaterial=trpc.opc.prepareVideoMaterial.useMutation(),checkVideo=trpc.opc.checkVideoExecution.useMutation(),saveResults=trpc.opc.saveVideoResults.useMutation();
 const start=trpc.runtime.start.useMutation(),prepare=trpc.runtime.prepare.useMutation(),execute=trpc.runtime.execute.useMutation(),cancel=trpc.runtime.cancel.useMutation();
 const [videoBusy,setVideoBusy]=useState(false),[,setVideoUiRevision]=useState(0);
 const busy=start.isPending||prepare.isPending||execute.isPending||videoBusy||guiding;
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
 async function send(scriptRequest=false){if(!workContextReady||!choices.data){setError('正在核对原工作与可用能力，请稍候；输入已保留。');return;}if(scriptRequest&&!isVideo)return;const videoChoice=isVideo&&currentScript?requestedVideoChoice(input):null;if(videoChoice){await chooseVideo(videoChoice);return;}setError('');try{
  const chosen=choices.data?.skills.find(s=>'skill:'+s.moduleId===activeSelection);
  const selected=chosen?{kind:'skill' as const,moduleId:chosen.moduleId,revisionId:chosen.revisionId}:activeSelection.startsWith('auto:')?{kind:'auto' as const,modelId:activeSelection.slice(5)}:{kind:'ordinary' as const,modelId:activeSelection};
  const url=new URL(location.href),requestId=url.searchParams.get('request')??crypto.randomUUID();url.searchParams.set('request',requestId);history.replaceState(null,'',url);
  const submitted=input;
  const admitted=await prepare.mutateAsync({sessionId,requestId,input:scriptRequest?'[OPC_SCRIPT_V1] 请基于当前选题简报讨论并给出可修改的口播稿。'+(submitted.trim()||'先给我一版口播稿。'):submitted,selection:selected,network:'deny',sources:[]});
  if(!alive.current)return;
  void utils.opc.conversations.invalidate();
  sessionStorage.removeItem('opc-runtime-send:'+sessionId);
  url.searchParams.delete('request');history.replaceState(null,'',url);
  setInput(current=>{if(current===submitted){localStorage.removeItem('opc-runtime-input:'+sessionId);return '';}return current;});
  const executed=await execute.mutateAsync({executionId:admitted.executionId});
  if(alive.current){if('unavailable' in executed&&executed.unavailable==='capacity'){markCapacity(admitted.executionId);setError('本次必要材料超过模型输入容量。原请求和已完成内容已保留；请取消剩余执行后缩短材料再发送。');}await Promise.all([view.refetch(),utils.opc.conversations.invalidate()]);}
 }catch{if(alive.current){setError('请求状态待核实。请读取原任务状态，不要重新发送相同内容。');await view.refetch();}}}
 const initialSend=useRef(false);
 useEffect(()=>{
  if(initialSend.current||!sessionId||!input.trim()||!workContextReady||!choices.data||!activeSelection||busy)return;
  const requestId=sessionStorage.getItem('opc-runtime-send:'+sessionId);
  if(!requestId||new URL(location.href).searchParams.get('request')!==requestId)return;
  initialSend.current=true;void send();
  // The marker records an explicit send on the start page, never mere navigation.
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
   const executed=await execute.mutateAsync({executionId:packageExecutionId});
   if('unavailable' in executed&&executed.unavailable==='capacity')throw new Error('OPC_CONTENT_CAPACITY');
   if(executed.state==='cancelled')throw new Error('OPC_CONTENT_DENIED');
   if(executed.state!=='completed')throw new Error('OPC_CONTENT_PENDING');
   await saveResults.mutateAsync({workItemId:op.workItemId,requestId:op.package.requestId,executionId:packageExecutionId,sourceScriptId,expectedStoryboardVersion:op.package.expectedStoryboardVersion,expectedEditingVersion:op.package.expectedEditingVersion,choice:op.choice??'both'});
   localStorage.setItem(videoKey+':completed:'+op.package.requestId,JSON.stringify(op));localStorage.removeItem(videoKey);const rejectedPackage=localStorage.getItem(videoKey+':rejected-source:'+op.script.executionId);if(rejectedPackage)localStorage.removeItem(videoKey+':rejected:'+rejectedPackage);localStorage.removeItem(videoKey+':rejected-source:'+op.script.executionId);await Promise.all([view.refetch(),library.refetch()]);
  });}catch(cause){const message=cause instanceof Error?cause.message:'';let definite=videoDefiniteRejections.has(message);if(!definite&&!active.followup.executionId&&active.sourceScriptId)try{await prepareVideoMaterial.mutateAsync({action:'abandon',workItemId:active.workItemId,requestId:active.followup.requestId,sourceScriptId:active.sourceScriptId,choice:active.choice??'both',expectedStoryboardVersion:active.package.expectedStoryboardVersion,expectedEditingVersion:active.package.expectedEditingVersion});definite=true;}catch{/* An admitted or unknown request remains frozen for exact replay. */}if(message==='OPC_CONTENT_BINDING'&&active.followup.executionId)try{await cancel.mutateAsync({executionId:active.followup.executionId});await view.refetch();}catch{definite=false;}if(definite){localStorage.setItem(videoKey+':rejected:'+active.package.requestId,JSON.stringify(active));localStorage.setItem(videoKey+':rejected-source:'+active.script.executionId,active.package.requestId);localStorage.removeItem(videoKey);setError(message==='OPC_CONTENT_RESPONSE_INVALID'?'分镜回复格式未通过保存校验，口播稿定稿已保留；请在原对话要求 Agent 重新整理。':'原视频工作请求已明确拒绝（'+message+'），没有再次派发。请刷新后基于最新版本重试。');}else if(message==='OPC_CONTENT_CAPACITY'){if(active.followup.executionId)markCapacity(active.followup.executionId);setError('分镜或剪辑所需材料超过模型输入容量。原请求与口播稿已保留；请取消剩余执行后缩短材料再继续。');}else setError('视频工作请求状态待核实。完整原请求已保留；再次点击只会恢复这一次请求。');}finally{setVideoBusy(false);}
 }
 async function finalizeScript(executionId:string,recoveryKey?:string){const key=recoveryKey??scriptKey;if(!workItem||!key)return;setVideoBusy(true);setError('');try{await navigator.locks.request(key,async()=>{const frozen=localStorage.getItem(key);const op:ScriptOperation=frozen?JSON.parse(frozen):{kind:isVideo?'script':'brief',workItemId:workItem.workItemId,requestId:executionId,executionId,expectedVersion:latest(isVideo?'script':'brief')};if(op.workItemId!==workItem.workItemId)throw new Error('OPC_REQUEST_CONFLICT');localStorage.setItem(key,JSON.stringify(op));await saveContent.mutateAsync({workItemId:op.workItemId,requestId:op.requestId,expectedVersion:op.expectedVersion,kind:op.kind??'script',status:op.kind==='script'?'final':'draft',executionId:op.executionId,sourceContentId:null});localStorage.setItem(key+':completed:'+op.requestId,JSON.stringify(op));localStorage.removeItem(key);await library.refetch();setVideoUiRevision(v=>v+1);});}catch(cause){const message=cause instanceof Error?cause.message:'';if(scriptDefiniteRejections.has(message)){localStorage.setItem(key+':rejected:'+executionId,localStorage.getItem(key)??'');localStorage.removeItem(key);setError('采用请求已明确拒绝（'+message+'），请刷新后核对最新版本。');}else setError('采用结果待核实。完整原请求已保留；再次点击只会恢复这一次请求。');}finally{setVideoBusy(false);}}
 async function chooseVideo(choice:VideoChoice|'end'){if(!isVideo||!currentScript||!workItem||!choices.data)return;if(choice==='end'){localStorage.setItem('opc-video-ended:'+currentScript.id,'true');setVideoUiRevision(v=>v+1);setError('');return;}if(choice==='editing'&&!currentStoryboard){setError('请先完成这版口播稿的分镜，再基于分镜生成剪辑建议。');return;}if(!videoSourceExecution){setError('这版口播稿缺少可恢复的来源，暂不能继续生成。');return;}if((choice==='both'&&(currentStoryboard||currentEditing))||(choice==='storyboard'&&currentStoryboard)||(choice==='editing'&&currentEditing)){setError('这版口播稿对应的所选成果已经生成，请在下方查看。');return;}const frozen=videoKey?localStorage.getItem(videoKey):null;if(frozen){await runVideo(JSON.parse(frozen));return;}const skill=choices.data.skills.find(s=>'skill:'+s.moduleId===activeSelection);const selection=skill?{kind:'skill' as const,moduleId:skill.moduleId,revisionId:skill.revisionId}:null;if(!selection){setError('请选择当前选题可用的 Skill，再继续生成。');return;}const requestId=crypto.randomUUID();const requested=choice==='both'?'生成分镜脚本和剪辑建议':choice==='storyboard'?'只生成分镜脚本':'只生成剪辑建议';const fields=choice==='both'?'storyboard 与 editing 两个字符串字段':choice==='storyboard'?'storyboard 一个字符串字段':'editing 一个字符串字段';const op:VideoOperation={workItemId:workItem.workItemId,choice,script:{requestId:currentScript.requestId,executionId:videoSourceExecution,expectedVersion:currentScript.version-1},sourceScriptId:currentScript.id,followup:{requestId,input:`[OPC_VIDEO_PACKAGE_V1] 用户已明确同意：基于资料中已定稿的口播稿，${requested}。遵循当前 Skill 的创作方法：先完成分镜，再依据分镜逐镜头给出剪辑建议；仅剪辑时必须依据资料中已保存的分镜，不得跳过分镜或自行补造。只返回严格 JSON 对象，且只含 ${fields}；不要生成图片、视频或执行发布。`,selection},package:{requestId,expectedStoryboardVersion:latest('storyboard'),expectedEditingVersion:latest('editing')}};await runVideo(op);}
 useEffect(()=>{if(!videoKey||videoAttempt.current||!workItem||!view.data)return;const raw=localStorage.getItem(videoKey);if(!raw)return;videoAttempt.current=true;void runVideo(JSON.parse(raw));
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[videoKey,workItem?.workItemId,view.data]);
 useEffect(()=>{if(!sessionId||!workItem||!view.data||videoBusy)return;for(const key of ['opc-script-final:'+sessionId,'opc-written-final:'+sessionId]){const raw=localStorage.getItem(key);if(!raw||scriptAttempt.current.has(key))continue;scriptAttempt.current.add(key);const op:ScriptOperation=JSON.parse(raw);void finalizeScript(op.executionId,key);break;}
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[sessionId,workItem?.workItemId,view.data,videoBusy]);

 async function stop(executionId:string){setError('');try{await cancel.mutateAsync({executionId});await view.refetch();}catch{setError('取消状态待核实，请读取原任务。');}}
 async function recover(executionId:string){setError('');try{const executed=await execute.mutateAsync({executionId});if('unavailable' in executed&&executed.unavailable==='capacity'){markCapacity(executionId);setError('原请求的必要材料超过模型输入容量，无法继续发送。已有内容已保留；请取消剩余执行后缩短材料再发送。');}await view.refetch();}catch{setError('暂时无法恢复，请保留原任务。');}}
 const executions=view.data?.executions as Array<{executionId:string;createdAt?:string;state:string;input:string|null;body:string|null;primaryBody:string|null;organizerComplete:boolean|null;skillExecution:boolean;needsTask:boolean;unavailableReason:string|null;contentAvailable:boolean}>|undefined;
 const capacitySignature=executions?.map(e=>e.executionId+':'+e.state).join('|');
 useEffect(()=>{const ids:string[]=[];for(const e of executions??[]){const key=capacityKey(e.executionId);if(e.state==='completed'||e.state==='cancelled'){try{sessionStorage.removeItem(key);}catch{/* No local marker to remove. */}}else try{if(sessionStorage.getItem(key)==='1')ids.push(e.executionId);}catch{/* Current request can still show the alert. */}}setCapacityIds(current=>current.join('|')===ids.join('|')?current:ids);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[sessionId,capacitySignature]);
 useEffect(()=>{
  const node=scrollArea.current;if(!node)return;
  const align=()=>node.parentElement?.style.setProperty('--chat-scrollbar-space',((node.offsetWidth-node.clientWidth)/2)+'px');
  align();const observer=new ResizeObserver(align);observer.observe(node);return()=>observer.disconnect();
 },[]);
 const scrollSignature=executions?.map(item=>[item.executionId,item.state,item.body,item.primaryBody].join(':')).join('|');
 useEffect(()=>{
  const node=scrollArea.current;if(!node||!scrollKey||scrollSignature===undefined)return;
  if(scrollState.current.key!==scrollKey){
   let saved:string|null=null;try{saved=sessionStorage.getItem(scrollKey);}catch{/* First entry uses the latest messages. */}
   const top=saved===null?NaN:Number(saved);
   node.scrollTop=Number.isFinite(top)?Math.max(0,top):node.scrollHeight;
   scrollState.current={key:scrollKey,follow:node.scrollHeight-node.clientHeight-node.scrollTop<80,signature:scrollSignature};
  }else if(scrollState.current.signature!==scrollSignature){
   if(scrollState.current.follow)node.scrollTop=node.scrollHeight;
   scrollState.current.signature=scrollSignature;
  }
 },[scrollKey,scrollSignature]);
 async function guide(){
  if(!workItem||!choices.data?.defaultSkill||!sessionId||contentType==='unknown')return;
  const stage=versions.at(-1)?.id??workItem.workItemId;
  const key='opc-work-guide:'+sessionId+':'+stage;
  const request={sessionId,requestId:stage,input:'[OPC_WORK_CONTINUE_V1] 工作阶段 '+stage+'。用户选择继续这条'+typeLabel[contentType]+'选题。请遵循当前Skill，结合现有简报、对话与已保存成果，主动用一句话说明当前进度，并提出一个最有帮助的细化或扩写问题。不要直接生成正文或口播稿，不要生成分镜、剪辑、图片、视频或发布；已定稿后只询问下一步意愿。',selection:{kind:'skill' as const,moduleId:choices.data.defaultSkill.moduleId,revisionId:choices.data.defaultSkill.revisionId},network:'deny' as const,sources:[]};
  if(executions?.some(e=>e.input?.startsWith('[OPC_WORK_CONTINUE_V1] 工作阶段 '+stage+'。')))return;
  setGuiding(true);setError('');
  try{await navigator.locks.request(key,async()=>{const raw=localStorage.getItem(key);const frozen=raw?JSON.parse(raw):request;localStorage.setItem(key,JSON.stringify(frozen));const admitted=await prepare.mutateAsync(frozen);const executed=await execute.mutateAsync({executionId:admitted.executionId});if('unavailable' in executed&&executed.unavailable==='capacity'){markCapacity(admitted.executionId);setError('引导请求的必要材料超过模型输入容量，原请求已保留；请取消剩余执行后缩短材料再发送。');}await view.refetch();});}
  catch{setError('引导请求待恢复。再次恢复会沿用原请求，不会另开一次。');}finally{setGuiding(false);}
 }
 useEffect(()=>{if(guidanceAttempt.current||!workItem||!view.data||!choices.data?.defaultSkill||contentType==='unknown'||view.data.activeExecution||videoBusy||Boolean(localStorage.getItem(videoKey))||Boolean(localStorage.getItem(scriptKey))||!new URL(location.href).searchParams.has('continue'))return;guidanceAttempt.current=true;void guide();
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[workItem,view.data,choices.data,contentType,videoBusy]);
 async function setType(value:string){if(!workItem)return;const key='opc-content-type:'+workItem.workItemId;try{await navigator.locks.request(key,async()=>{const raw=localStorage.getItem(key);const frozen=raw?JSON.parse(raw):{requestId:crypto.randomUUID(),target:'item' as const,targetId:workItem.workItemId,expectedRevision:workItem.revision,patch:{title:workItem.title,brief:workItem.brief??'',day:workItem.day,contentType:value}};localStorage.setItem(key,JSON.stringify(frozen));setTypePending(true);await editItem.mutateAsync(frozen);localStorage.removeItem(key);setTypePending(false);await library.refetch();});}catch(cause){const code=cause instanceof Error?cause.message:'';if(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_DENIED','OPC_LIBRARY_INVALID'].includes(code)){localStorage.setItem(key+':rejected',localStorage.getItem(key)??'');localStorage.removeItem(key);setTypePending(false);await library.refetch();setError('类型保存已明确拒绝，已读取当前版本，请重新确认。');}else setError('类型保存状态待核实；再次选择会恢复原请求，不会覆盖为另一类型。');}}

 return <WorkspaceFrame area="chat" activeWorkItemId={workItem?.workItemId} notice={choices.data?.mode==='staging_test'?'Staging 真实对话测试 · 消耗测试预算':choices.data?.mode==='isolated'?'本地隔离 · 模型回复为模拟，保存写入本地测试服务':undefined} rightOpen={panelOpen} onToggleRight={()=>setPanelOpen(value=>!value)} right={workItem?(contentType==='unknown'?<div className={workStyles.typePending}><h2>当前成果</h2><p>先在对话中确认这条选题的内容类型，再起草和保存稿件。已确认前不会创建内容版本。</p></div>:<ContentEditor key={workItem.workItemId+':'+contentType} item={workItem} onSaved={()=>library.refetch()}>{(isVideo||Boolean(saved.data?.length))&&<section aria-label={isVideo?'视频派生成果':'其他 Skill 成果'} className={workStyles.videoResults}>{isVideo&&<><h2>分镜与剪辑建议</h2>{versions.filter(version=>version.kind==='storyboard'||version.kind==='editing').map(version=><details key={version.id}><summary>{version.kind==='storyboard'?'分镜':'剪辑建议'} · 第 {version.version} 版 · {version.status==='final'?'已定稿':'草稿'}{version.sourceContentId===currentScript?.id?' · 匹配当前口播稿':' · 旧口播稿版本'}</summary><p>{version.body}</p></details>)}</>}{saved.data?.map((artifact:{artifactId:string;version:number;body:string|null})=><details key={artifact.artifactId}><summary>其他 Skill 成果 · 第 {artifact.version} 版</summary><p>{artifact.body??'来源不可用'}</p></details>)}<Link href={'/library?item='+workItem.workItemId+'&return='+sessionId}>在资料库查看这个选题</Link></section>}</ContentEditor>):undefined}><main className={`${workStyles.conversation} flex h-full min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]`}>
  <header className={workStyles.workHead}>
   <div className={workStyles.workTitle}><h1>{workItem?.title??'工作对话'}</h1>{!workItem&&<small>{(choices.data?.mode??view.data?.mode)==='staging_test'?'Staging 真实对话测试':'本地模拟体验'}</small>}</div>
   {workItem?<div className={workStyles.workMeta}><span>{workItem.platform} · {workItem.account}</span><Link href={'/library?item='+workItem.workItemId+'&return='+sessionId}>工作信息</Link>{!panelOpen&&<button type="button" onClick={()=>setPanelOpen(true)}>展开成果</button>}</div>:!sessionId&&requestedModule?<Button variant="outline" disabled={busy||!choices.data||Boolean(input.trim())||Boolean(requestedModule&&!chosenModule)} onClick={open}><Plus className="mr-2 h-4 w-4"/>用此功能准备新任务</Button>:null}
  </header>
  {requestedModule&&!chosenModule&&<p className="shrink-0 px-6 py-1 text-center text-[11px] text-[var(--text-tertiary)]">所选功能当前不满足本地工作区准入条件；不会自动换用其他功能。</p>}
  {(choices.error||view.error||library.error)&&<p role="alert" className="p-4 text-center">当前环境不可用，或你无权访问此工作。</p>}
  <div ref={scrollArea} onScroll={rememberScroll} className={workStyles.scrollArea} aria-label="对话记录">
   {!executions?.length&&<div className="mx-auto flex min-h-64 max-w-xl flex-col items-center justify-center px-6 py-12 text-center"><Bot className="mb-4 h-9 w-9 text-[var(--color-primary)]"/><h2 className="text-2xl font-semibold">开始一段对话</h2><p className="mt-3 text-sm text-[var(--text-tertiary)]">{workItem?'已带入选题简报和原工作方法，正在根据当前进度准备引导。':sessionId?'输入一条消息，发送后可刷新查看记录。':'从左侧“新对话”开始。'}</p></div>}
   <section className={workStyles.transcript}>{workItem&&typePending&&<Button disabled={editItem.isPending} onClick={()=>setType('unknown')}>恢复类型保存</Button>}{workItem&&contentType==='unknown'&&<section className="rounded-xl border p-4" aria-label="确认内容类型"><h2>这条选题准备做成什么内容？</h2><p>先确认形式，再一起细化重点和结构。</p><div className="flex gap-2 mt-3">{['article','image_text','video'].map(value=><Button key={value} disabled={busy||editItem.isPending||typePending} onClick={()=>setType(value)}>{typeLabel[value]}</Button>)}</div></section>}{error.startsWith('引导请求')&&<Button disabled={busy} onClick={guide}>恢复引导</Button>}{executions?.map((e,index)=><div key={e.executionId}>{e.createdAt&&(index===0||!executions[index-1].createdAt||transcriptDay(executions[index-1].createdAt!)!==transcriptDay(e.createdAt))&&<p className={workStyles.dateMarker}>{transcriptDate(e.createdAt)}</p>}<article className={workStyles.turn}>
    {e.input&&!e.input.startsWith('[OPC_WORK_CONTINUE_V1]')&&<p className={workStyles.userMessage}>{e.input.startsWith('[OPC_VIDEO_PACKAGE_V1]')?(e.input.includes('只生成分镜脚本')?'请基于已定稿口播稿生成分镜脚本。':e.input.includes('只生成剪辑建议')?'请基于已保存的分镜生成剪辑建议。':'请先完成分镜脚本，再基于分镜生成剪辑建议。'):e.input.replace(/^\[OPC_SCRIPT_V1\]\s*/, '')}</p>}
    <div className={workStyles.agentMessage}><div className={workStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/><span>Graylum · {e.skillExecution&&e.state==='completed'&&!e.input?.startsWith('[OPC_WORK_CONTINUE_V1]')&&!e.input?.startsWith('[OPC_VIDEO_PACKAGE_V1]')?'已完成本轮建议':'增长顾问'}</span></div><div>
     {workItem&&e.skillExecution&&e.state==='completed'&&!e.input?.startsWith('[OPC_WORK_CONTINUE_V1]')&&!e.input?.startsWith('[OPC_VIDEO_PACKAGE_V1]')&&e.contentAvailable?<div className={workStyles.proposal}><div className={workStyles.proposalHead}><strong>建议稿</strong><span>{versions.some(v=>v.kind===(isVideo?'script':'brief')&&v.executionId===e.executionId)?'已采用':'尚未采用'}</span></div><p>{displayReply(e.input,e.body??e.primaryBody)}</p></div>:<p className={workStyles.reply}>{e.contentAvailable?displayReply(e.input,e.body??e.primaryBody):'来源已不可用，暂不展示此内容。'}</p>}
     {e.primaryBody&&!e.organizerComplete&&<p role="status" className="mt-2 text-sm">主回复已保存，附属整理未完成。</p>}
     {workItem&&contentType!=='unknown'&&e.state==='completed'&&e.skillExecution&&!e.input?.startsWith('[OPC_VIDEO_PACKAGE_V1]')&&!e.input?.startsWith('[OPC_WORK_CONTINUE_V1]')&&<div className="mt-3 flex flex-wrap gap-2">{versions.some(v=>v.kind===(isVideo?'script':'brief')&&v.executionId===e.executionId)?<Link className="underline" href={'/library?item='+workItem.workItemId+'&return='+sessionId}>{isVideo?'这版口播稿已定稿':'已采用为草稿'} · 查看</Link>:<Button disabled={busy} onClick={()=>finalizeScript(e.executionId)}>{isVideo?'将这条回复定稿为口播稿':'采用为当前草稿'}</Button>}</div>}
     {workItem&&contentType==='unknown'&&e.state==='completed'&&e.skillExecution&&e.contentAvailable&&!e.input?.startsWith('[OPC_WORK_CONTINUE_V1]')&&!e.input?.startsWith('[OPC_VIDEO_PACKAGE_V1]')&&<div className="mt-2">{saved.data?.find((result:{artifactId:string;version:number})=>result.artifactId===e.executionId)?<p role="status">已保存成果 · 第 {saved.data.find((result:{artifactId:string;version:number})=>result.artifactId===e.executionId)?.version} 版</p>:<Button variant="outline" disabled={saveWorkResult.isPending} onClick={()=>persistSkillResult(e.executionId)}>保存 Skill 成果</Button>}</div>}
     {e.state==='cancelled'&&<p role="status" className="mt-2 text-sm">已取消剩余执行，保留原记录。</p>}
     {e.state==='cost_pending'&&<p role="status" className="mt-2 text-sm">费用待核实；恢复只核对原调用。</p>}
     {e.needsTask&&<p className="mt-2 text-sm">当前入口暂不支持这个 Skill 的任务选择。可取消剩余执行后使用普通对话。</p>}
     {e.unavailableReason==='latest_unavailable'&&<p className="mt-2 text-sm">本次未取得搜索资料，无法提供已核实的最新信息。</p>}
     {capacityIds.includes(e.executionId)&&e.state!=='completed'&&e.state!=='cancelled'&&<p role="status" className="mt-2 text-sm">本次必要材料超过模型输入容量，原请求和已完成内容已保留。取消剩余执行后可缩短材料并新发请求。</p>}
     {e.state!=='completed'&&e.state!=='cancelled'&&<div className="mt-3 flex flex-wrap gap-2">{!capacityIds.includes(e.executionId)&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>recover(e.executionId)}>恢复原任务</Button>}<Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={()=>stop(e.executionId)}>取消剩余执行</Button></div>}
    </div></div>
   </article></div>)}
   {isVideo&&currentScript&&videoPromptEnded&&(!currentStoryboard||!currentEditing)&&<Button variant="outline" onClick={()=>{localStorage.removeItem('opc-video-ended:'+currentScript.id);setVideoUiRevision(v=>v+1);}}>继续这版口播稿的分镜或剪辑</Button>}
   {isVideo&&currentScript&&!videoPromptEnded&&(!currentStoryboard||!currentEditing)&&<section aria-label="口播稿后续选择" className="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4"><h2 className="font-medium">{currentStoryboard?'分镜已保存。要基于这版分镜生成剪辑建议吗？':'口播稿已定稿。要先制作分镜脚本吗？'}</h2><p className="text-sm text-[var(--text-secondary)]">本次只绑定口播稿第 {currentScript.version} 版。选择后才会调用 Agent；以后重新定稿口播稿时不会自动生成。</p><div className="flex flex-wrap gap-2">{!currentStoryboard&&<Button disabled={busy||currentEditing} onClick={()=>chooseVideo('both')}>先做分镜，再生成剪辑建议</Button>}{!currentStoryboard&&<Button variant="outline" disabled={busy} onClick={()=>chooseVideo('storyboard')}>只生成分镜</Button>}{currentStoryboard&&<Button variant="outline" disabled={busy||currentEditing} onClick={()=>chooseVideo('editing')}>只生成剪辑建议</Button>}<Button variant="ghost" disabled={busy} onClick={()=>chooseVideo('end')}>暂时结束</Button></div><p className="text-xs text-[var(--text-tertiary)]">也可以在消息框输入同样的选择；提问卡和自然语言只执行同一个业务动作。</p></section>}
{busy&&<p role="status" className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]"><Loader2 className="h-4 w-4 animate-spin"/>正在处理，请稍候…</p>}</section>
  </div>
  {sessionId&&<footer className={`${composerStyles.zone} ${workStyles.composerZone}`}><div className={composerStyles.wrap}>
   {workItem&&isVideo&&<Button variant="outline" disabled={busy||Boolean(view.data?.activeExecution)||!choices.data?.defaultSkill} onClick={()=>send(true)}>{currentScript?'修改口播稿':'起草口播稿'}</Button>}
   <WorkComposer value={input} onChange={updateInput} onSend={()=>void send()} disabled={busy||Boolean(view.data?.activeExecution)} sendDisabled={!workContextReady||!choices.data||!activeSelection} sessionId={sessionId} skillId={activeSelection.startsWith('skill:')?activeSelection.slice(6):''} onSkillChange={id=>{setSelection(id?'skill:'+id:ordinary);if(id)localStorage.setItem('opc-runtime-skill:'+sessionId,id);else localStorage.removeItem('opc-runtime-skill:'+sessionId);}} note={workItem?'本次讨论参考当前工作的最新成果。Enter 发送，Shift + Enter 换行。':'可以自由提问；Agent 按需查阅相关资料。Enter 发送，Shift + Enter 换行。'}/>
  </div></footer>}{error&&<p role="alert" className="shrink-0 p-3 text-center text-sm">{error}</p>}
 </main></WorkspaceFrame>;
}
