/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {NativeTextUpdate} from './nativeProgress';
import {AGENT_TURN_MESSAGE_LIMIT,type QuestionCard} from '../../shared/agentTurn';
export type RuntimeProgress=NativeTextUpdate|{type:'card';card:QuestionCard}|{type:'text';text:string}|{type:'phase';phase:'mentor'|'organizer'|'saving'};
/** Only the leading public message string of the OPC JSON protocol may leave
 * the server. Partial escapes wait for the next provider chunk. Never forward
 * raw JSON, reasoning, provider metadata or later structured fields. */
export function publicMentorText(raw:string):string {
 const start=/^\s*\{\s*"message"\s*:\s*"/.exec(raw);if(!start)return '';
 let encoded='';
 for(let i=start[0].length;i<raw.length;i++){
  const c=raw[i]!;if(c==='"')break;
  if(c==='\\'){
   const next=raw[i+1];if(next===undefined)break;
   if(next==='u'){if(i+5>=raw.length)break;const hex=raw.slice(i+2,i+6);if(!/^[0-9a-f]{4}$/i.test(hex))return '';encoded+=raw.slice(i,i+6);i+=5;}
   else {if(!'"\\/bfnrt'.includes(next))return '';encoded+=c+next;i++;}
  }else{if(c.charCodeAt(0)<32)return '';encoded+=c;}
 }
 try{return (JSON.parse('"'+encoded+'"') as string).trimStart().slice(0,4000);}catch{return '';}
}
/** Agent turn (AC-1) replies are plain text: the SDK's public text deltas,
 * never reasoning or tool arguments, bounded like a stored message. */
export function publicAgentText(raw:string):string {
 return raw.trimStart().slice(0,AGENT_TURN_MESSAGE_LIMIT);
}
