/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The tools one execution offers its primary model, from its frozen context only, and the request bytes they take.
import type {z} from 'zod';
import {executionSkillFileTool} from '../turn/skills/skillFileExecution';
import {executionLoadSkillTool,LOAD_SKILL_TOOL} from '../turn/skills/loadSkillTool';
import {skillCatalogReserveBytes} from '../turn/skills/skillCatalog';
import {skillFileToolBytes} from '../turn/skills/skillFile';
import {executionMentorHistoryTool,mentorHistoryToolBytes} from '../turn/agent/mentorHistory';
import {sourceRuntimeTool} from '../turn/research/sourceRuntimeTool';
import {withSourceWorkProgress} from './sourceWorkProgress';
import type {AgentToolEvent} from '../../shared/agentWork';
import {promptCacheReserveBytes} from '../turn/provider/promptCache';
import {groundedCardTool,groundedCardToolBytes,type cardSources} from '../turn/agent/groundedCard';
import {askQuestionTool,askQuestionToolBytes,READ_HISTORY_TOOL} from '../turn/agent/agentTools';
import {ASK_QUESTION_TOOL} from '../../shared/agentTurn';
import type {runtimeContext} from '../turn/agent/runtimeContext';
import type {RuntimeTool} from '../turn/agent/runner';
import type {ResearchExecution} from './researchExecution';
import type {RequestTiming} from '../turn/provider/timing';
import type {ToolRpc} from '../turn/skills/skillFileExecution';

export function executionTools(input:{
 context:z.infer<typeof runtimeContext>;executionId:string;args:{p_execution_id:string};
 agentTurn:boolean;grounded:boolean;fiveFields:boolean;sources:()=>ReturnType<typeof cardSources>;
 ownerRpc:ToolRpc;budget:{assertCanStart:(ms?:number)=>void;timing?:RequestTiming};
 execution:{live?:boolean;sessionId:string};research:ResearchExecution|null;onRefused:()=>void;
 onProgress?:(event:AgentToolEvent)=>void;
 exchange:Parameters<typeof sourceRuntimeTool>[0]['exchange'];
}):{tools:RuntimeTool[];toolBytes:number;catalogReserve:number}{
 const {context,executionId,ownerRpc,budget,research}=input;
 const questionTool=input.grounded?groundedCardTool(input.sources):askQuestionTool(input.fiveFields);
 const tools:RuntimeTool[]=context.tools.map(name=>research?.tools.find(tool=>tool.name===name)??
  (name===ASK_QUESTION_TOOL?questionTool:
  name==='read_skill_file'?executionSkillFileTool({executionId,moduleId:context.moduleId!,binding:context.skillFile!,
   rpc:ownerRpc,assertCanStart:()=>budget.assertCanStart(),timing:budget.timing,onRefused:input.onRefused}):
  name===LOAD_SKILL_TOOL?executionLoadSkillTool({executionId,catalog:context.skillCatalog!,maxResultBytes:context.skillCatalogMaxBytes!,
   maxLoads:context.maxSkillLoads!,rpc:ownerRpc,assertCanStart:()=>budget.assertCanStart(),onRefused:input.onRefused}):
  name===READ_HISTORY_TOOL?executionMentorHistoryTool({executionId,rpc:ownerRpc,assertCanStart:()=>budget.assertCanStart(),
   onRefused:input.onRefused}):
  withSourceWorkProgress(sourceRuntimeTool({name,context,args:input.args,ownerRpc,budget,
   execution:input.execution,exchange:input.exchange}),input.onProgress,Boolean(context.ownPosts),context)));
 const toolBytes=(input.agentTurn?(input.grounded?groundedCardToolBytes():askQuestionToolBytes(input.fiveFields)):
  Buffer.byteLength(JSON.stringify(tools.map(t=>({name:t.name,description:t.description})))))+
  (context.skillFile?skillFileToolBytes():0)+(context.historyRead?mentorHistoryToolBytes():0)+(research?.definitionBytes??0)+
  (context.historySelection?.markerReserveBytes??promptCacheReserveBytes(context.promptCache));
 // The loads this reply may make: reserved once, in the first history selection only, never in later per-call totals.
 return {tools,toolBytes,catalogReserve:context.skillCatalog?skillCatalogReserveBytes(context.skillCatalog):0};
}
