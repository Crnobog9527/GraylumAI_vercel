/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { paygOwnerDatabase } from './paygOwner';
import { PostgresSession } from './session';
const id = '10000000-0000-4000-8000-000000000001';
function fixture() {
  const database = { rpc: vi.fn(async () => ({ data: [], error: null })) };
  return { database, owner: paygOwnerDatabase(database, { executionId: id, epoch: 7 }) };
}
it.each(['fail_before_dispatch', 'interrupt', 'checkpoint_match', 'checkpoint_primary', 'check_latest', 'complete'])(
  'carries the observed epoch on %s without mutating the saved value', async action => {
    const f = fixture(), value = { body: 'saved' };
    await f.owner.rpc('runtime_execution', { p_actor_id: id, p_execution_id: id, p_action: action, p_result: value });
    expect(f.database.rpc).toHaveBeenCalledWith('runtime_execution', { p_actor_id: id, p_execution_id: id,
      p_action: action, p_result: { epoch: 7, value } });
    expect(value).toEqual({ body: 'saved' });
  });
it('wraps internal cancellation and both tool actions under the owner epoch', async () => {
  const f = fixture();
  await f.owner.rpc('runtime_cancel', { p_actor_id: id, p_execution_id: id });
  expect(f.database.rpc).toHaveBeenLastCalledWith('runtime_execution', { p_actor_id: id,
    p_execution_id: id, p_action: 'owner_cancel', p_result: { epoch: 7, value: null } });
  for (const action of ['claim', 'complete']) {
    await f.owner.rpc('runtime_tool', { p_actor_id: id, p_call_id: 'tool-1', p_name: 'read_source',
      p_arguments: {}, p_action: action, p_result: action === 'complete' ? { body: 'source' } : undefined });
    expect(f.database.rpc).toHaveBeenLastCalledWith('runtime_execution', { p_actor_id: id,
      p_execution_id: id, p_action: 'owner_tool', p_result: { epoch: 7, value: {
        callId: 'tool-1', name: 'read_source', arguments: {}, action,
        result: action === 'complete' ? { body: 'source' } : null } } });
  }
});
it('passes real SDK Session freeze/append through the owner wrapper; read stays read-only', async () => {
  const f = fixture();
  const session = new PostgresSession(f.owner, { actorId: id, sessionId: id, executionId: id });
  await session.getItems();
  expect(f.database.rpc).toHaveBeenLastCalledWith('runtime_session_items', expect.objectContaining({ p_action: 'read' }));
  await session.freezeHistory(0);
  expect(f.database.rpc).toHaveBeenLastCalledWith('runtime_execution', { p_actor_id: id, p_execution_id: id,
    p_action: 'owner_session', p_result: { epoch: 7, value: { action: 'freeze', items: [], limit: null, batch: null } } });
  await session.addItems([{ role: 'user', content: 'original input' }]);
  expect(f.database.rpc).toHaveBeenLastCalledWith('runtime_execution', { p_actor_id: id, p_execution_id: id,
    p_action: 'owner_session', p_result: { epoch: 7, value: { action: 'append',
      items: [{ role: 'user', content: 'original input' }], limit: null, batch: 0 } } });
});
it.each(['runtime_financial_recovery', 'runtime_response', 'bill2_record'])(
  'leaves independent receipt/financial/read API %s unchanged', async name => {
    const f = fixture(), args = { p_actor_id: id, p_execution_id: id };
    await f.owner.rpc(name, args);
    expect(f.database.rpc).toHaveBeenCalledWith(name, args);
  });
