/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SessionRpc } from './session';
const ownerActions = new Set([
  'fail_before_dispatch', 'interrupt', 'checkpoint_match', 'checkpoint_primary', 'check_latest', 'complete',
]);
/** Keep one invocation's epoch on every owner write, including SDK Session writes.
 * SQL validates it while holding the original Session/execution/run locks. */
export function paygOwnerDatabase(database: SessionRpc, binding: {
  executionId: string; epoch: number;
}): SessionRpc {
  return { rpc(name, args) {
    let action: string | undefined;
    let value: unknown = null;
    if (name === 'runtime_execution' && ownerActions.has(String(args.p_action))) {
      action = String(args.p_action);
      value = args.p_result ?? null;
    } else if (name === 'runtime_cancel') action = 'owner_cancel';
    else if (name === 'runtime_session_items' && ['freeze', 'append'].includes(String(args.p_action))) {
      action = 'owner_session';
      value = { action: args.p_action, items: args.p_items ?? null,
        limit: args.p_limit ?? null, batch: args.p_batch ?? null };
    } else if (name === 'runtime_tool') {
      action = 'owner_tool';
      value = { callId: args.p_call_id, name: args.p_name, arguments: args.p_arguments,
        action: args.p_action, result: args.p_result ?? null };
    }
    if (!action) return database.rpc(name, args);
    return database.rpc('runtime_execution', { p_actor_id: args.p_actor_id,
      p_execution_id: binding.executionId, p_action: action, p_result: { epoch: binding.epoch, value } });
  } };
}
