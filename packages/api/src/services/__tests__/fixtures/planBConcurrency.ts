/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect} from 'vitest';
import pg from 'pg';

/** Two real backends, with a positively observed lock barrier before the first commits. */
export async function overlap<A, B>(observer: pg.Client, connectionString: string,
  lockSql: string, lockArgs: unknown[], first: (client: pg.Client) => Promise<A>, second: (client: pg.Client) => Promise<B>) {
  const a = new pg.Client({connectionString}), b = new pg.Client({connectionString});
  await a.connect(); await b.connect();
  try {
    await a.query("begin; set local statement_timeout='10s'"); await b.query("set statement_timeout='10s'");
    const pa = (await a.query('select pg_backend_pid() pid')).rows[0].pid;
    const pb = (await b.query('select pg_backend_pid() pid')).rows[0].pid;
    expect(pa).not.toBe(pb);
    await a.query(lockSql, lockArgs);
    const pending = second(b).then(value => ({ok: true as const, value}), error => ({ok: false as const, error: String(error)}));
    let blocked = false;
    for (let i = 0; i < 150; i++) {
      const row = (await observer.query('select pg_blocking_pids($1) blockers', [pb])).rows[0];
      if (row.blockers.includes(pa)) {blocked = true; break;}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked, 'The second database operation must actually wait on the first').toBe(true);
    const value = await first(a); await a.query('commit');
    return {value, other: await pending};
  } finally {await a.query('rollback'); await a.end(); await b.end();}
}
