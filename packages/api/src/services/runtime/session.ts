/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { AgentInputItem, Session } from '@openai/agents';
import { z } from 'zod';

export interface SessionRpc {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
const uuid = z.string().uuid();

/** A run-scoped view of the persistent SDK Session. The database owns concurrency,
 * membership and append idempotency; this object owns no history or execution state.
 * Actor/session/execution come from authenticated server admission, never model text.
 */
export class PostgresSession implements Session {
  private historyRevisions:number[]=[];
  private batch = 0; // Deterministic SDK append ordinal, never authoritative history.
  private readonly binding: Readonly<{ actorId: string; sessionId: string; executionId: string }>;
  constructor(private readonly database: SessionRpc, binding: { actorId: string; sessionId: string; executionId: string }) {
    this.binding = Object.freeze(z.object({ actorId: uuid, sessionId: uuid, executionId: uuid }).strict().parse(binding));
  }
  private async request(action: 'read' | 'append' | 'freeze', items?: AgentInputItem[] | number[], limit?: number): Promise<unknown> {
    const response = await this.database.rpc('runtime_session_items', {
      p_actor_id: this.binding.actorId, p_session_id: this.binding.sessionId,
      p_execution_id: this.binding.executionId, p_action: action,
      p_items: items ?? null, p_limit: limit ?? null, p_batch: action === 'append' ? this.batch : null,
    });
    // Never expose a database/SDK error which may include private history.
    if (response.error) throw new Error('RUNTIME_SESSION_UNAVAILABLE');
    return response.data;
  }
  async getSessionId(): Promise<string> {
    // Also verify membership for an SDK caller that asks only for the ID.
    await this.request('read', undefined, 0);
    return this.binding.sessionId;
  }
  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('RUNTIME_SESSION_LIMIT');
    const items = await this.request('read', undefined, limit);
    if (!Array.isArray(items)) throw new Error('RUNTIME_SESSION_UNAVAILABLE');
    const rows=z.array(z.object({revision:z.number().int().nonnegative(),item:z.unknown()})).parse(items);
    this.historyRevisions=rows.map(r=>r.revision);
    return rows.map(r=>r.item) as AgentInputItem[];
  }
  async freezeHistory(count:number):Promise<void>{
    if(!Number.isSafeInteger(count)||count<0||count>this.historyRevisions.length)throw new Error('RUNTIME_HISTORY_SELECTION');
    await this.request('freeze',count?this.historyRevisions.slice(-count):[]);
  }
  async addItems(items: AgentInputItem[]): Promise<void> {
    await this.request('append', items);
    this.batch++;
  }
  // Runtime context selection/organizing must retain originals. These SDK operations
  // are intentionally unsupported, preventing fallback clear-and-rebuild compaction.
  async popItem(): Promise<AgentInputItem | undefined> { throw new Error('RUNTIME_HISTORY_IMMUTABLE'); }
  async clearSession(): Promise<void> { throw new Error('RUNTIME_HISTORY_IMMUTABLE'); }
}
