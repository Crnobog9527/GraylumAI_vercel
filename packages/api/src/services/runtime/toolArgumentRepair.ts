/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * OpenRouter's Anthropic stream sometimes drops the empty-string literal of a tool argument: the model meant
 * `{"query": ""}` (list the index) and the frames add up to `{"query": }`. The Agents SDK cannot parse that, runs no
 * tool, tells the model so, and the model repeats the same call until the turns run out (seen on staging, three times in
 * a row). For the owned-source read the one missing piece is repaired before the SDK sees it: a value missing right before
 * a closing brace becomes the empty string. The paid response evidence is stored unchanged; every path (live stream,
 * replay, saved response) applies the same repair, so the SDK sees identical bytes each time.
 */
const REPAIRED_TOOLS: ReadonlySet<string> = new Set(['read_source']);

/** `{"query": }` → `{"query": ""}`; anything that already parses, or that this does not fix, is returned as it was. */
export function repairArguments(raw: string): string {
  try { JSON.parse(raw); return raw; } catch { /* repair below */ }
  const repaired = raw.replace(/:(\s*)\}\s*$/, ':$1""}');
  if (repaired === raw) return raw;
  try { JSON.parse(repaired); return repaired; } catch { return raw; }
}

type ToolCall = {function?: {name?: unknown; arguments?: unknown}};
/** A complete assistant message (non-streamed or replayed): repair each read_source call's arguments. */
export function repairMessageToolCalls<T extends {tool_calls?: unknown}>(message: T): T {
  const calls = message.tool_calls;
  if (!Array.isArray(calls)) return message;
  let changed = false;
  const fixed = calls.map((call: ToolCall) => {
    const fn = call?.function;
    if (!fn || typeof fn.arguments !== 'string' || !REPAIRED_TOOLS.has(String(fn.name))) return call;
    const arguments_ = repairArguments(fn.arguments);
    if (arguments_ === fn.arguments) return call;
    changed = true;
    return {...call, function: {...fn, arguments: arguments_}};
  });
  return changed ? {...message, tool_calls: fixed} : message;
}

/**
 * Stream frames of one response, in order: when a read_source argument delta starts with a closing brace while the
 * arguments so far end with `:` (the empty string was dropped), the missing `""` is put in front of it. Frames that
 * need no repair are returned byte for byte.
 */
export function newFrameRepairer(): (chunk: string) => string {
  const names = new Map<number, string>();
  const so_far = new Map<number, string>();
  return (chunk: string): string => {
    let frame: {choices?: Array<{delta?: {tool_calls?: Array<{index?: number; function?: {name?: string; arguments?: string}}>}}>};
    try { frame = JSON.parse(chunk); } catch { return chunk; }
    const calls = frame?.choices?.[0]?.delta?.tool_calls;
    if (!Array.isArray(calls)) return chunk;
    let changed = false;
    for (const call of calls) {
      const index = call?.index, fn = call?.function;
      if (typeof index !== 'number' || !fn) continue;
      if (typeof fn.name === 'string' && fn.name) names.set(index, (names.get(index) ?? '') + fn.name);
      if (typeof fn.arguments !== 'string' || !REPAIRED_TOOLS.has(names.get(index) ?? '')) continue;
      const before = so_far.get(index) ?? '';
      if (/^\s*\}/.test(fn.arguments) && /:\s*$/.test(before)) { fn.arguments = '""' + fn.arguments; changed = true; }
      so_far.set(index, before + fn.arguments);
    }
    return changed ? JSON.stringify(frame) : chunk;
  };
}
