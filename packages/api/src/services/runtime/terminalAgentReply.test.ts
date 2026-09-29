/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {terminalAgentReplyFailure} from './terminalAgentReply';
const reply=(message:unknown,finish_reason='stop')=>({choices:[{message,finish_reason}]});
const call=(name:string)=>({function:{name}});
it.each([false,true])('classifies terminal refusal and filtered output in either v5 phase (%s)',organizer=>{
 expect(terminalAgentReplyFailure(reply({content:null,refusal:'Refused'}),organizer)).toBe(true);
 expect(terminalAgentReplyFailure(reply({content:'Partial'},'content_filter'),organizer)).toBe(true);
});
it('honors only the first question tool and rejects every organizer tool',()=>{
 expect(terminalAgentReplyFailure(reply({tool_calls:[call('unknown'),call('ask_question')]}))).toBe(true);
 expect(terminalAgentReplyFailure(reply({tool_calls:[call('ask_question'),call('unknown')]}))).toBe(false);
 expect(terminalAgentReplyFailure(reply({tool_calls:[call('ask_question')]},'tool_calls'),true)).toBe(true);
});
it.each([null,'','  \n'])('only empty successful organizer output is terminal (%j)',content=>{
 expect(terminalAgentReplyFailure(reply({content}))).toBe(false);
 expect(terminalAgentReplyFailure(reply({content}),true)).toBe(true);
 expect(terminalAgentReplyFailure(reply({content},'length'),true)).toBe(false);
 expect(terminalAgentReplyFailure(reply({content},''),true)).toBe(false);
});
it('does not classify incomplete or malformed transport evidence as a terminal reply',()=>{
 for(const value of [null,{}, {choices:[]},{choices:[{}]}, {choices:[{},{}]}])
  expect(terminalAgentReplyFailure(value,true)).toBe(false);
 expect(terminalAgentReplyFailure(reply({content:'Kept proposal'}),true)).toBe(false);
});
