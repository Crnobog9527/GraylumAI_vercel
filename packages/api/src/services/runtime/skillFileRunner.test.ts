/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect, it, vi} from 'vitest';
import type {Session, AgentInputItem} from '@openai/agents';
import {runRuntime} from './runner';
import {skillFileTool} from './skillFile';
import {askQuestionTool} from './agentTools';
import {terminalAgentReplyFailure} from './terminalAgentReply';
const readCall = {id: 'read_1', type: 'function', function: {
  name: 'read_skill_file', arguments: '{"path":"references/guide.md"}',
}};
const response = (content: string | null, tool_calls?: unknown[]) => JSON.stringify({
  id: 'test', object: 'chat.completion', created: 1, model: 'fixture',
  choices: [{index: 0, finish_reason: tool_calls ? 'tool_calls' : 'stop',
    message: {role: 'assistant', content, ...(tool_calls ? {tool_calls} : {})}}],
});

it.each([false, true])('continues after a frozen file read and saves a complete SDK history (stream=%s)', async stream => {
  const writes: AgentInputItem[][] = [];
  const session: Session = {getSessionId: async () => 'test', getItems: async () => [],
    addItems: async items => {writes.push(items);}, popItem: async () => undefined, clearSession: async () => {}};
  const read = vi.fn(async () => '{"content":"fixed reference"}');
  const requests: string[] = [];
  const exchange = vi.fn(async (_sequence: number, body: string) => {
    requests.push(body);
    expect(writes).toHaveLength(0);
    return requests.length === 1 ? response(null, [readCall]) : response('Reference-grounded answer');
  });
  const output = await runRuntime({model: 'fixture', instructions: 'Read then answer.', input: 'help',
    session, maxOutputTokens: 100, maxTurns: 2, tools: [askQuestionTool(), skillFileTool(read)],
    stream, firstToolCallOnly: true, commitSessionOnSuccess: true, allowEmptyResult: true,
    stopAtToolNames: ['ask_question'], selectHistory: async (_history, incoming) => incoming, exchange});
  expect(output).toBe('Reference-grounded answer');
  expect(read).toHaveBeenCalledTimes(1);
  expect(exchange).toHaveBeenCalledTimes(2);
  expect(requests[1]).toContain('fixed reference');
  expect(JSON.stringify(writes)).toContain('read_1');
  expect(JSON.stringify(writes)).toContain('fixed reference');
});
it('accepts file calls only when the frozen host context offered that tool', () => {
  const parsed = JSON.parse(response(null, [readCall]));
  expect(terminalAgentReplyFailure(parsed, false, true)).toBe(true);
  expect(terminalAgentReplyFailure(parsed, false, true, true)).toBe(false);
  expect(terminalAgentReplyFailure(parsed, true, true, true)).toBe(true);
});
