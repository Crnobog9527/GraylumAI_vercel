/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The tools one execution offers its primary model, from its frozen context only, and the request bytes they take.
import type {z} from 'zod';
import {executionSkillFileTool} from './skillFileExecution';
import {skillFileToolBytes} from './skillFile';
import {executionMentorHistoryTool,mentorHistoryToolBytes} from './mentorHistory';
import {sourceRuntimeTool} from './sourceRuntimeTool';
import {withSourceWorkProgress} from './sourceWorkProgress';
import type {AgentToolEvent} from '../../shared/agentWork';
import {PROMPT_CACHE_OVERHEAD_BYTES} from './promptCache';
import {groundedCardTool,groundedCardToolBytes,type cardSources} from './groundedCard';
import {askQuestionTool,askQuestionToolBytes,READ_HISTORY_TOOL} from './agentTools';
import {ASK_QUESTION_TOOL} from '../../shared/agentTurn';
import type {runtimeContext} from './runtimeContext';
import type {RuntimeTool} from './runner';
import type {ResearchExecution} from './researchExecution';
import type {RequestTiming} from './timing';
import type {ToolRpc} from './skillFileExecution';

export function executionTools(input:{
 context:z.infer<typeof runtimeContext>;executionId:string;args:{p_execution_id:string};
 agentTurn:boolean;grounded:boolean;fiveFields:boolean;sources:()=>ReturnType<typeof cardSources>;
 ownerRpc:ToolRpc;budget:{assertCanStart:(ms?:number)=>void;timing?:RequestTiming};
 execution:{live?:boolean;sessionId:string};research:ResearchExecution|null;onRefused:()=>void;
 onProgress?:(event:AgentToolEvent)=>void;
 exchange:Parameters<typeof sourceRuntimeTool>[0]['exchange'];
}):{tools:RuntimeTool[];toolBytes:number}{
 const {context,executionId,ownerRpc,budget,research}=input;
 const questionTool=input.grounded?groundedCardTool(input.sources):askQuestionTool(input.fiveFields);
 const tools:RuntimeTool[]=context.tools.map(name=>research?.tools.find(tool=>tool.name===name)??
  (name===ASK_QUESTION_TOOL?questionTool:
  name==='read_skill_file'?executionSkillFileTool({executionId,moduleId:context.moduleId!,binding:context.skillFile!,
   rpc:ownerRpc,assertCanStart:()=>budget.assertCanStart(),timing:budget.timing,onRefused:input.onRefused}):
  name===READ_HISTORY_TOOL?executionMentorHistoryTool({executionId,rpc:ownerRpc,assertCanStart:()=>budget.assertCanStart(),
   onRefused:input.onRefused}):
  withSourceWorkProgress(sourceRuntimeTool({name,context,args:input.args,ownerRpc,budget,
   execution:input.execution,exchange:input.exchange}),input.onProgress,Boolean(context.ownPosts))));
 const toolBytes=(input.agentTurn?(input.grounded?groundedCardToolBytes():askQuestionToolBytes(input.fiveFields)):
  Buffer.byteLength(JSON.stringify(tools.map(t=>({name:t.name,description:t.description})))))+
  (context.skillFile?skillFileToolBytes():0)+(context.historyRead?mentorHistoryToolBytes():0)+(research?.definitionBytes??0)+
  (context.historySelection?.markerReserveBytes??(context.promptCache?PROMPT_CACHE_OVERHEAD_BYTES:0));
 return {tools,toolBytes};
}
