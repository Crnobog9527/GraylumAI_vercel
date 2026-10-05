/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {readFileSync} from 'node:fs';
import {expect} from 'vitest';
import type pg from 'pg';
import type {SupabaseClient} from '@supabase/supabase-js';
import {readNativeRuntimeView} from './nativeView';

// Registered in runtime.integration.ts, so the existing CI Runtime suite runs it.
// Same file-built fixture as the full local before/after benchmark; no provider calls.
export async function assertLongSessionPerformance(db: pg.Client) {
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL track_functions='all'");
    await db.query(readFileSync(new URL('../../../../db/tests/runtime-view-perf/fixture.sql',import.meta.url),'utf8'));
    const f=(await db.query('select runtime_perf_test.seed(100) f')).rows[0].f;
    await db.query('ANALYZE runtime_history_dependencies');
    await db.query('ANALYZE runtime_executions');
    const checks=async()=>Number((await db.query(
      "select calls from pg_stat_xact_user_functions where funcname='runtime_direct_billing_allowed'"
    )).rows[0]?.calls??0);
    for(const [sql,args] of [
      ['select runtime_view($1,$2)',[f.actor,f.session]],
      ["select runtime_session_items($1,$2,$3,'read')",[f.actor,f.session,f.execution]],
    ] as const) {
      for(let i=0;i<3;i++) {
        const before=await checks();
        const plan=(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,[...args])).rows[0]['QUERY PLAN'];
        expect(plan[0]['Execution Time']).toBeLessThan(1000);
        // Session read also retains the separate current-execution authorization (100 nodes).
        expect((await checks())-before).toBe(sql.includes('runtime_session_items')?199:100);
      }
    }
    const view=(await db.query('select runtime_view($1,$2) v',[f.actor,f.session])).rows[0].v;
    expect(view.executions).toHaveLength(100);
    expect(view.executions.every((e:{contentAvailable:boolean})=>e.contentAvailable)).toBe(true);
    let metadataReads = 0;
    const scoped = { rpc: async (name: string, args: Record<string, string>) => {
      if (name === 'runtime_view') return { error: null, data: (await db.query(
        'select runtime_view($1,$2) v', [args.p_actor_id,args.p_session_id])).rows[0].v };
      expect(name).toBe('runtime_execution');
      expect(args.p_action).toBe('read');
      metadataReads++;
      return { error: null, data: (await db.query(
        "select runtime_execution($1,$2,'read') v", [args.p_actor_id,args.p_execution_id])).rows[0].v };
    } } as unknown as SupabaseClient;
    const nativeStarted = performance.now();
    const nativeView = await readNativeRuntimeView(scoped,f.actor,f.session);
    expect(performance.now()-nativeStarted).toBeLessThan(1000);
    expect(metadataReads).toBe(4);
    expect(nativeView).toEqual(view);
    await db.query(`update runtime_executions set unavailable_reason='source_revoked'
      where session_id=$1 and history_revision=0`,[f.session]);
    const denied=(await db.query('select runtime_view($1,$2) v',[f.actor,f.session])).rows[0].v;
    expect(denied.executions).toHaveLength(100);
    expect(denied.executions.every((e:{contentAvailable:boolean;body:null;input:null})=>
      !e.contentAvailable&&e.body===null&&e.input===null)).toBe(true);
    await expect(db.query("select runtime_session_items($1,$2,$3,'read')",[f.actor,f.session,f.execution]))
      .rejects.toMatchObject({code:'P0001',message:'RUNTIME_HISTORY_UNAVAILABLE'});
  } finally {
    await db.query('ROLLBACK');
  }
}
