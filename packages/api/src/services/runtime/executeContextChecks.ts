/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Which tools a frozen context may offer for its request format (moved out of execute.ts unchanged).
import type {z} from 'zod';
import {READ_HISTORY_TOOL} from './agentTools';
import {ASK_QUESTION_TOOL} from '../../shared/agentTurn';
import type {runtimeContext} from './runtimeContext';

export function assertExecutionTools(context:z.infer<typeof runtimeContext>,agentTurn:boolean,fiveFields:boolean):void{
 if(fiveFields&&!agentTurn)throw new Error('RUNTIME_CONTEXT_INVALID');
 if(agentTurn&&(context.matching||context.workspaceContext||context.tools.some(name=>name!==ASK_QUESTION_TOOL&&
  name!=='read_skill_file'&&name!==READ_HISTORY_TOOL&&!context.research)))throw new Error('RUNTIME_CONTEXT_INVALID');
 if(!agentTurn&&context.tools.includes(ASK_QUESTION_TOOL))throw new Error('RUNTIME_CONTEXT_INVALID');
}
