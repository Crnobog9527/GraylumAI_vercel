/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {streamingMentorText} from './mentorText';
import {NativeMessageScanner, NativeTextAccumulator} from './nativeMessageScanner';

export type NativeTextSource = 'assistant' | 'message' | 'final';
export type NativeTextUpdate = {
  source?: NativeTextSource;
  type: 'text';
  /** Cumulative compatibility value for existing text subscribers. */
  text: string;
  /** Newly decoded public text, never raw provider content. */
  delta: string;
  /** Discard pending deltas and replace the visible source. */
  replace: boolean;
};
export type NativeTextDelta = {type: 'textDelta'; offset: number; text: string; rev: number; source?: NativeTextSource};

type ToolFrame = {choices?: Array<{delta?: {tool_calls?: Array<{
  index?: number; function?: {name?: string; arguments?: string};
}>}}>};

/** One primary exchange only. Create a new instance when the provider exchange changes. */
export class NativeProgressProjection {
  private readonly assistant: NativeTextAccumulator;
  private readonly message: NativeMessageScanner;
  private readonly tool: NativeMessageScanner;
  private toolName = '';
  private toolVisible = false;
  private visible = '';
  private source: NativeTextSource;

  constructor(private readonly options: {
    mode: 'message-first' | 'agent'; toolMessage?: boolean; maxCodePoints?: number; appendCard?: boolean;
  }) {
    this.source = options.mode === 'agent' ? 'assistant' : 'message';
    this.assistant = new NativeTextAccumulator(options.maxCodePoints);
    this.message = new NativeMessageScanner(true, options.maxCodePoints);
    this.tool = new NativeMessageScanner(false, options.maxCodePoints);
  }

  get text(): string { return this.visible; }
  get messageFirst(): boolean { return this.message.messageFirst; }

  appendText(fragment: string): NativeTextUpdate | null {
    if (this.toolVisible) return null;
    const source = this.options.mode === 'message-first' ? this.message : this.assistant;
    const delta = source.append(fragment);
    return delta ? this.update(source.text, delta, false) : null;
  }

  /** Accept the raw JSON frame string or its parsed shape; never mutate the frame. */
  appendToolFrame(frame: unknown): NativeTextUpdate | null {
    if (!this.options.toolMessage) return null;
    let parsed: ToolFrame;
    try { parsed = (typeof frame === 'string' ? JSON.parse(frame) : frame) as ToolFrame; }
    catch { return null; }
    const calls = parsed?.choices?.[0]?.delta?.tool_calls;
    if (!Array.isArray(calls)) return null;
    let delta = '';
    for (const call of calls) {
      if (call?.index !== 0) continue;
      if (typeof call.function?.name === 'string') this.toolName += call.function.name;
      if (typeof call.function?.arguments === 'string') delta += this.tool.append(call.function.arguments);
    }
    if (this.toolName !== 'ask_question' || !this.tool.text) return null;
    if (this.options.appendCard) {
      this.toolVisible = true;
      const text = streamingMentorText(this.assistant.text, this.tool.text);
      const added = text.slice(this.visible.length);
      return added ? this.update(text, added, false) : null;
    }
    if (!this.toolVisible) {
      this.toolVisible = true;
      this.source = 'message';
      return this.update(this.tool.text, this.tool.text, true);
    }
    return delta ? this.update(this.tool.text, delta, false) : null;
  }

  /** Call before card/result emission, including invalid-card or truncated-tool fallbacks. */
  finish(authoritative: string): NativeTextUpdate | null {
    if (authoritative === this.visible) return null;
    if (this.options.appendCard && authoritative.startsWith(this.visible)) {
      return this.update(authoritative, authoritative.slice(this.visible.length), false);
    }
    this.source = 'final';
    return this.update(authoritative, authoritative, true);
  }

  private update(text: string, delta: string, replace: boolean): NativeTextUpdate {
    this.visible = text;
    return {type: 'text', text, delta, replace, source: this.source};
  }
}

/** Per HTTP stream; call flush under the existing 100ms throttle. No persistent state. */
export class NativeTextTransport {
  private pending: string[] = [];
  private snapshot = false;
  private sent = false;
  private offset = 0;
  private rev = 0;
  private source: NativeTextSource | undefined;

  push(update: NativeTextUpdate): void {
    if (update.source !== undefined) this.source = update.source;
    if (update.replace) {
      // No delta queued before a source switch may follow the replacement snapshot.
      this.pending = [update.text];
      this.snapshot = true;
    } else this.pending.push(update.delta);
  }

  flush(): NativeTextDelta | null {
    if (!this.pending.length) return null;
    const text = this.pending.join('');
    this.pending = [];
    const replace = this.snapshot || !this.sent;
    if (replace && this.sent) this.rev++;
    if (replace) this.offset = 0;
    const event: NativeTextDelta = {type: 'textDelta', offset: this.offset, text, rev: this.rev,
      ...(replace && this.source ? {source: this.source} : {})};
    this.offset += Array.from(text).length;
    this.sent = true;
    this.snapshot = false;
    return event;
  }
}
