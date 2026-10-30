/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { withCatalogRequest } from '../runtime/catalogCache';
import { MENTOR, organized, prose, tiktokVendors, toolCall } from './__tests__/mentorSynthetic';
import { turnClients } from './db';
import { runMentorTurn } from './mentor';

/*
 * The process mentor.integration.ts kills with SIGKILL: a mentor turn whose benchmark_fetch stops inside its sixth supplier call,
 * so the first batch's receipt is written and the second batch never is.
 */
type Input = { rest: string; serviceJwt: string; actor: string; session: string; moduleId: string; accounts: string[] };
const { rest, serviceJwt, actor, session, moduleId, accounts } = JSON.parse(process.argv[2]!) as Input;
const admin = createClient(rest, serviceJwt, { auth: { persistSession: false } });
const admit = async () => ({ ok: true as const });
let calls = 0, requests = 0;
const transport: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { model: string };
  requests++;
  if (body.model !== MENTOR) return organized('gen-org-' + requests, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }));
  return requests > 1 ? prose('gen-reply-' + requests, 'Checked.') : toolCall('gen-reply-1', 'benchmark_fetch',
    { accounts: accounts.map(account => ({ platform: 'tiktok', account })), source: { kind: 'user_message', messageId: null } });
};
const research = tiktokVendors(async () => {
  process.stdout.write(`call ${++calls}\n`);
  if (calls === 6) await new Promise(() => setInterval(() => undefined, 1000));
});
await withCatalogRequest(() => runMentorTurn({ admin, clients: turnClients(admin), slots: { take: async () => 1, drop: async () => undefined }, transport,
  newWork: { message: admit, calls: admit }, research }, { actorId: actor, sessionId: session, requestId: randomUUID(), moduleId, stepId: 'step-0',
  text: 'Check ' + accounts.map(a => `https://www.tiktok.com/@${a}`).join(' '), organizeAfter: true }, () => undefined));
