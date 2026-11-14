/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { REQUEST_MINUTES_INSTRUCTIONS, REQUEST_MINUTES_LABEL, REQUEST_MINUTES_TOOL, requestMinutesTool, requestMinutesToolBytes } from './requestMinutes';
import { stepEnd, stepStart } from './toolStage';
import { FREE_CHAT_TOOL_NAMES } from '../agent/agentTools';

// CONTENT-CONVERSATION-2 PR3b: the chat's way to start the minutes. A signal only; the page starts the minutes turn from its step.
describe('request_minutes', () => {
  it('answers once per reply, at once, and counts as a free call', async () => {
    let free = 0;
    const tool = requestMinutesTool({ usable: true, onCall: () => { free++; } });
    expect(tool.name).toBe(REQUEST_MINUTES_TOOL);
    expect(tool.enabled?.()).toBe(true);
    expect(JSON.parse(await tool.execute({}, 'c1'))).toMatchObject({ status: 'ok' });
    expect(free).toBe(1);
    expect(tool.enabled?.()).toBe(false);
    expect(JSON.parse(await tool.execute({}, 'c2'))).toMatchObject({ status: 'not_supported' });
    expect(free).toBe(1);
  });
  it('does nothing where the turn could not use it', async () => {
    let free = 0;
    const tool = requestMinutesTool({ usable: false, onCall: () => { free++; } });
    expect(JSON.parse(await tool.execute({}, 'c1'))).toMatchObject({ status: 'not_supported' });
    expect(free).toBe(0);
  });
  it('leaves the fixed step the page reads, ended as done', () => {
    expect(stepStart(REQUEST_MINUTES_TOOL, {}, new Map())).toEqual({ tool: 'other', label: REQUEST_MINUTES_LABEL });
    expect(stepEnd('other', JSON.stringify({ status: 'ok' })).state).toBe('done');
  });
  it('is a free-chat tool whose history replays, with a short definition and the rules the model follows', () => {
    expect(FREE_CHAT_TOOL_NAMES.has(REQUEST_MINUTES_TOOL)).toBe(true);
    expect(requestMinutesToolBytes()).toBeLessThan(1200);
    expect(REQUEST_MINUTES_INSTRUCTIONS).toContain('never write the minutes in your reply');
    expect(REQUEST_MINUTES_INSTRUCTIONS).toContain('not a minutes request');
    // Staging evaluation of #2012: in a topic window "sort out this topic's progress" did not start the minutes.
    expect(REQUEST_MINUTES_INSTRUCTIONS).toContain('帮我把这个选题目前的进度整理一下');
  });
});
