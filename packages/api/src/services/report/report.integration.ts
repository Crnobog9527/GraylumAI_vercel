/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { makeWorkflow } from '../__tests__/fixtures/artifacts';

type Fixture = { actor: string; user: SupabaseClient; admin: SupabaseClient; registration: string;
  mentorModel: string; flow: ReturnType<typeof makeWorkflow> };
export function registerReportTests(db: pg.Client, fixture: () => Promise<Fixture>) {
  it('RUNTIME: REPORT-MODEL configuration window and column deny non-admin clients', async () => {
    const f = await fixture();
    const result = await f.admin.rpc('report_model_window', { p_actor_id: f.actor, p_window_id: randomUUID() });
    expect(result.error?.message).toBe('REPORT_MODEL_ADMIN_REQUIRED');
    const windowId = randomUUID();
    await db.query(`insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,
      max_cost_usd,max_calls,expires_at) values($1,true,$2,'[{}]',100,6,1,1,now()+interval '1 hour')`,
      [windowId, [randomUUID()]]);
    await db.query("update profiles set role='admin' where id=$1", [f.actor]);
    const allowed = await f.admin.rpc('report_model_window', { p_actor_id: f.actor, p_window_id: windowId });
    expect(allowed.error).toBeNull(); expect(allowed.data.id).toBe(windowId);
    const callPermission = await f.admin.rpc('runtime_test_policy', { p_actor_id: f.actor, p_window_id: windowId });
    expect(callPermission.error?.message).toBe('RUNTIME_TEST_WINDOW_DENIED');
    await db.query('update runtime_test_windows set enabled=false where id=$1', [windowId]);
    const disabled = await f.admin.rpc('report_model_window', { p_actor_id: f.actor, p_window_id: windowId });
    expect(disabled.error?.message).toBe('REPORT_MODEL_ADMISSION_REQUIRED');

    const grants = (await db.query(`select
      has_column_privilege('authenticated','modules','report_model_id','UPDATE') can_update,
      has_column_privilege('anon','modules','report_model_id','SELECT') can_read,
      has_function_privilege('authenticated','report_model_window(uuid,uuid)','EXECUTE') can_execute`)).rows[0];
    expect(grants).toEqual({ can_update: false, can_read: false, can_execute: false });
    await db.query('update modules set active=false where id=(select module_id from artifact_workflows where id=$1)', [f.registration]);
  });
}
