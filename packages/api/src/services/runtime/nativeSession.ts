/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { AgentInputItem, Session } from '@openai/agents';
import { fitNativeSessionItem } from './resultCapacity';

type Item = Record<string, unknown>;
function shortText(text: string): string {
  const prefix = text.slice(0, 4000);
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}
function assistantText(item: Item, text: string): Item {
  if (typeof item.content === 'string') return { ...item, content: text };
  if (!Array.isArray(item.content)) return item;
  let written = false;
  return { ...item, content: item.content.map(part => {
    if (!part || part.type !== 'output_text') return part;
    const value = { ...part, text: written ? '' : text };
    written = true;
    return value;
  }) };
}
function companionText(item: Item): Item {
  if (typeof item.content === 'string') return assistantText(item, shortText(item.content));
  if (!Array.isArray(item.content)) return item;
  return assistantText(item, shortText(item.content.filter(part => part?.type === 'output_text')
    .map(part => part.text ?? '').join('')));
}
function cardResult(output: unknown, card: Item): unknown {
  const replace = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      return parsed?.card === 'question' ? JSON.stringify({ card: 'question', ...card }) : text;
    } catch { return text; }
  };
  if (typeof output === 'string') return replace(output);
  if (output && typeof output === 'object' && 'type' in output && output.type === 'text'
    && 'text' in output && typeof output.text === 'string') return { ...output, text: replace(output.text) };
  return output;
}

/** Holds only this run's pending appends, so native results and Session use one saved projection. */
export class NativeSession implements Session {
  private pending: AgentInputItem[][] = [];
  private projected: AgentInputItem[][] | null = null;
  private appended = 0;
  private finished = false;
  constructor(private readonly inner: Session) {}
  getSessionId() { return this.inner.getSessionId(); }
  getItems(limit?: number) { return this.inner.getItems(limit); }
  popItem() { return this.inner.popItem(); }
  clearSession() { return this.inner.clearSession(); }
  async addItems(items: AgentInputItem[]): Promise<void> {
    if (!this.finished) {
      this.pending.push(structuredClone(items));
      return;
    }
    // Organizer prose can be omitted from Session; its complete receipt remains authoritative.
    const bounded = items.filter(item => {
      if (fitNativeSessionItem(item) !== null) return true;
      if ('role' in item && item.role === 'assistant') return false;
      throw new Error('RUNTIME_SESSION_CAPACITY');
    });
    await this.inner.addItems(bounded);
  }
  async finish(authoritativeBody: string, agentTurn: boolean, rewrite = true): Promise<void> {
    if (this.finished) return;
    if (!this.projected) this.projected = this.project(authoritativeBody, agentTurn, rewrite);
    while (this.appended < this.projected.length) {
      await this.inner.addItems(this.projected[this.appended]!);
      this.appended++;
    }
    this.pending = [];
    this.finished = true;
  }
  private project(body: string, agentTurn: boolean, rewrite: boolean): AgentInputItem[][] {
    let message = body;
    let card: Item | null = null;
    if (agentTurn) {
      const envelope = JSON.parse(body) as { message: string; card?: Item | null };
      message = envelope.message;
      card = envelope.card ?? null;
    }
    const all = this.pending.flat() as Item[];
    const lastAssistant = all.findLastIndex(item => item.role === 'assistant');
    let ordinal = 0;
    return this.pending.map(batch => batch.flatMap(original => {
      let item = original as Item;
      const index = ordinal++;
      if (card && item.role === 'assistant') item = companionText(item);
      else if (rewrite && index === lastAssistant) item = assistantText(item, message);
      if (rewrite && card && item.type === 'function_call' && item.name === 'ask_question') {
        item = { ...item, arguments: JSON.stringify(card) };
      }
      if (rewrite && card && item.type === 'function_call_result' && item.name === 'ask_question') {
        item = { ...item, output: cardResult(item.output, card) };
      }
      if (fitNativeSessionItem(item) === null) {
        if (card && item.role === 'assistant') return [];
        throw new Error('RUNTIME_SESSION_CAPACITY');
      }
      return [item as AgentInputItem];
    }));
  }
}
