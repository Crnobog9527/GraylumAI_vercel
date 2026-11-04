/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TurnStop } from '../call';
import { stepEnd, stepStart } from './toolStage';
import type { RuntimeTool } from '../agent/runner';
import type { StepEvent } from '../sse';

/** The tool whose call is the reply itself (a question card): no step is shown for it. */
const SILENT_TOOLS: ReadonlySet<string> = new Set(['ask_question']);

/**
 * Wraps each tool so the page is told when it starts and how it ended (one `step` event each, same id). Telling the page can
 * never change what the tool does: whatever the announcing throws is dropped, and the tool's own result or error passes through.
 * A TurnStop raised inside a tool reaches `onStop` first (the turn, not the SDK's error wrapper, owns it).
 */
export function withStepEvents(tools: readonly RuntimeTool[], announce: ((event: StepEvent) => void) | undefined,
  skillNames: ReadonlySet<string>, onStop?: (stop: TurnStop) => void): RuntimeTool[] {
  let stepNumber = 0;
  return tools.map(tool => SILENT_TOOLS.has(tool.name) ? tool : ({ ...tool, async execute(args, callId) {
    const tell = (make: () => StepEvent) => { try { announce?.(make()); } catch { /* display only */ } };
    const id = String(++stepNumber);
    let start: ReturnType<typeof stepStart> = { tool: 'other' };
    try { start = stepStart(tool.name, args, skillNames); } catch { /* display only */ }
    tell(() => ({ type: 'step', id, ...start, state: 'running' }));
    let result: string;
    try { result = await tool.execute(args, callId); }
    catch (error) {
      tell(() => ({ type: 'step', id, ...start, state: 'failed' }));
      if (error instanceof TurnStop) onStop?.(error);
      throw error;
    }
    tell(() => ({ type: 'step', id, ...start, ...stepEnd(start.tool, result) }));
    return result;
  } }));
}
