/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { readFileSync } from 'node:fs';

import { expect, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';

/** What scripts/e2e-sim/run.mjs seeded (packages/api/src/scripts/e2eSim/seed.ts). Local, disposable accounts only. */
export interface SimSeed { users: Record<'alice' | 'bob', { id: string; email: string; password: string }>; models: Record<string, string> }
export type SimRole = keyof SimSeed['users'];

export const seed = (): SimSeed => JSON.parse(readFileSync(process.env.SIM_SEED_FILE!, 'utf8')) as SimSeed;

let client: Sql | null = null;
/** The disposable local database (full access: it exists only for this run). */
export function db(): Sql {
  const url = process.env.SIM_DB_URL ?? '';
  if (!/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/sim$/.test(url)) throw new Error('local simulation database required');
  client ??= postgres(url, { max: 2, prepare: false, idle_timeout: 5 });
  return client;
}

export type SimFault = { mode: 'cut' | 'timeout' | 'silent' | 'malformed' | '402'; target?: 'primary' | 'organizer' | 'any'; times?: number; receipt?: boolean };

/** Arms a failure in the simulated model for its next matching call(s). */
export async function armFault(fault: SimFault) {
  const response = await fetch(`${process.env.SIM_ORIGIN}/__sim/fault`, { method: 'POST', body: JSON.stringify(fault) });
  expect(response.ok, 'the simulator accepted the fault').toBe(true);
}

export async function resetSim() {
  await fetch(`${process.env.SIM_ORIGIN}/__sim/reset`, { method: 'POST' });
}

export async function simCalls(): Promise<Array<{ model: string; role: string; fault: string | null }>> {
  return ((await (await fetch(`${process.env.SIM_ORIGIN}/__sim/calls`)).json()) as { calls: Array<{ model: string; role: string; fault: string | null }> }).calls;
}

/** Signs in through the real login page. */
export async function signIn(page: Page, role: SimRole) {
  const user = seed().users[role];
  await page.goto('/login');
  await page.locator('#email, input[type="email"]').first().fill(user.email);
  await page.locator('#password, input[type="password"]').first().fill(user.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 60_000 });
}

export interface Turn { id: string; kind: string; state: string; close_kind: string | null; settlement: string | null; charged: number | null;
  reserved: number; failure_code: string | null; session_id: string | null }

export async function turns(actorId: string, afterId = '0'): Promise<Turn[]> {
  return db()<Turn[]>`select id::text, kind, state, close_kind, settlement, charged_credits as charged, reserved_credits as reserved,
    failure_code, session_id::text from turns where actor_id = ${actorId}::uuid and id > ${afterId}::bigint order by id`;
}

export async function lastTurnId(actorId: string): Promise<string> {
  return (await db()<Array<{ id: string }>>`select coalesce(max(id), 0)::text as id from turns where actor_id = ${actorId}::uuid`)[0]!.id;
}

/** The balance the account really has, and the balance its newest credit record says it left: once settled the two agree. */
export async function ledger(actorId: string) {
  const [row] = await db()<Array<{ credits: number; recorded: number | null }>>`select p.credits,
    (select t.balance_after::int from credit_transactions t where t.user_id = p.id order by t.created_at desc, t.id desc limit 1) as recorded
    from profiles p where p.id = ${actorId}::uuid`;
  return row!;
}

/** Nothing frozen: every turn of the account is closed and settled (a turn that never held credits needs no settlement). */
export async function expectNothingFrozen(actorId: string, timeoutMs = 60_000) {
  await expect.poll(async () => (await turns(actorId)).filter(t => t.state !== 'closed' || (t.settlement !== 'done' && t.reserved > 0))
    .map(t => `${t.id} ${t.kind} ${t.state}/${t.close_kind}/${t.settlement}`), { message: 'no turn left open or unsettled', timeout: timeoutMs }).toEqual([]);
}

/** The sidebar's balance ("积分 N"), as the user sees it. */
export const sidebarCredits = (page: Page) => page.getByRole('button', { name: /^积分\s*(\d+|查看)$/ });
export async function readSidebarCredits(page: Page): Promise<number> {
  const text = await sidebarCredits(page).innerText();
  const match = /(\d+)/.exec(text);
  if (!match) throw new Error(`the sidebar shows no balance: ${text}`);
  return Number(match[1]);
}

export const replies = (page: Page) => page.getByRole('button', { name: /保存到成果夹|再存一段到成果夹/ });

/** Starts a free conversation from the start page; returns its session id. */
export async function startFreeChat(page: Page, text: string): Promise<string> {
  await page.goto('/app/positioning');
  await page.getByRole('textbox', { name: '新任务内容' }).click();
  await page.keyboard.insertText(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForURL(/\/app\/runtime\?session=[0-9a-f-]{36}/, { timeout: 120_000 });
  return new URL(page.url()).searchParams.get('session')!;
}

/** Runs the recovery job once, as the every-minute scheduler does (it settles turns whose cost was unknown). */
export async function runRecovery() {
  const response = await fetch(`${process.env.SIM_BASE_URL}/api/cron/runtime-recovery`,
    { headers: { authorization: `Bearer ${process.env.SIM_CRON_SECRET}` }, signal: AbortSignal.timeout(90_000) });
  return { status: response.status, body: await response.json().catch(() => null) as unknown };
}
