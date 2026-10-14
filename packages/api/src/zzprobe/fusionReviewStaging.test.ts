/* Local-only staging probe for FUSION-REVIEW PR-4b. Not committed. Prints no secrets or report text. */
import { it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createClient } from '@supabase/supabase-js';

const WINDOW = '9d02a18e-f61b-4dbf-b32b-c2af95b0b310';
// The only substitution: the deployment check (Vercel staging branch) is replaced by this window id.
vi.mock('../services/runtime/stagingEnvironment', async original => ({
  ...(await original<typeof import('../services/runtime/stagingEnvironment')>()), stagingRuntimeWindow: () => WINDOW }));

import { authoritativeBilling, type BillingRpc } from '../services/bill2/service';
import { createRuntimeBudget } from '../services/runtime/budget';
import { runtimeActor } from '../services/runtime/actor';
import { loadStagingPolicy } from '../services/runtime/stagingPolicy';
import { stagingTransport } from '../services/runtime/stagingTransport';
import { reportRevisionService } from '../services/report/revisionSync';
import { fusionExecutor } from '../services/fusion/executor';
import { reviewFlow } from '../services/fusion/review';
import { estimateReview } from '../services/fusion/reviewEstimate';
import { saveFusionSettings } from '../services/fusion/settingsAdmin';
import { readFusionSettings } from '../services/fusion/settings';
import { resolveReviewSkill, readReviewSkill } from '../services/fusion/reviewPrompts';
import { decodeOpenRouterStreamObservation } from '../services/bill2/openRouterEvidence';
import { recoverFusionFinancials } from '../services/fusion/recovery';
import { parseStagingPolicy } from '../services/runtime/stagingPolicy';
import { checkRevision, reportSections } from '../services/fusion/hostChecks';
import { paygHostSettings } from '../services/runtime/paygHostPolicy';

const URL_ = 'https://gvcpmcunmfrbxuwimxfa.supabase.co';
const ACTOR = 'cfb600ed-d169-4570-ba8d-3ccaa9ad5912';
const DRAFT = 'cf4ef8bc-9971-4491-9f24-2586dea8ae51';
const VERSION = 'a2616664-8090-4ea7-b81a-0ee5990e0ec1';
const MODELS = { gemini: 'da9e7046-fddc-4b97-bf65-a275b05d6cf0', luna: '2cf4bf00-c24c-4c48-a7e7-b99f68806d71', sonnet: 'd04a4800-2d3a-43b3-8af9-cb960572e34f' };
const SKILL = 'd8e3b832-e0bd-40b4-8dac-29a3ca39b518';
const STATE = homedir() + '/.graylum/fusion-review-pr4b/probe-state.json';
const mode = process.env.PROBE_MODE ?? '';

function keys() {
  const list = JSON.parse(execFileSync('supabase', ['projects', 'api-keys', '--project-ref', 'gvcpmcunmfrbxuwimxfa', '-o', 'json'], { encoding: 'utf8' }));
  const service = list.find((k: { name: string }) => k.name === 'service_role')?.api_key;
  const anon = list.find((k: { name: string }) => k.name === 'anon')?.api_key;
  if (!service || !anon) throw new Error('keys unavailable');
  return { service, anon };
}
async function userSession(serviceKey: string) {
  const { createSession } = await import(homedir() + '/.graylum/staging-login/session.mjs');
  const { loadAccounts } = await import(homedir() + '/.graylum/staging-login/guards.mjs');
  const accounts = await loadAccounts(homedir() + '/.graylum/secrets/staging-test-accounts.json');
  for (const [role, email] of [...(accounts as Map<string, string>)]) {
    if (role.startsWith('_')) continue;
    try { const s = await createSession({ key: serviceKey, email }); if (s.user.id === ACTOR) return { role, s }; } catch { /* next */ }
  }
  throw new Error('test account for actor not in the local list');
}
const settingsFor = (maxBudgetUsd: string, maxRounds = Number(process.env.PROBE_ROUNDS ?? 2)) => ({ version: 1, compare: { enabled: false }, review: { enabled: true,
  reviewerModelIds: [MODELS.gemini, MODELS.luna, MODELS.sonnet], summaryModelId: process.env.PROBE_SUMMARY === 'sonnet' ? MODELS.sonnet : MODELS.gemini, skillId: SKILL, maxRounds,
  opinionOutputTokens: 4096, summaryOutputTokens: 16384, maxBudgetUsd, dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 } } });

it.skipIf(!process.env.PROBE_MODE)('fusion review staging probe', async () => {
  const k = keys();
  const admin = createClient(URL_, k.service, { auth: { persistSession: false, autoRefreshToken: false } });
  if (mode === 'plan') {
    for (const [n, a] of [['fusion_review_read', { p_actor_id: ACTOR, p_review_id: randomUUID() }], ['fusion_review_unjudged', { p_limit: 1 }]] as const) { const r = await admin.rpc(n, a); console.log('RPC', n, r.error ? r.error.message : 'ok'); }
    const window = await loadStagingPolicy(admin as unknown as BillingRpc, ACTOR, {});
    const pr = await admin.rpc('fusion_review_preview', { p_actor_id: ACTOR, p_draft_id: DRAFT, p_source_version_id: VERSION }); if (pr.error) console.log('PREVIEW_ERR', pr.error.message, pr.error.code); const preview = pr.data ?? { reportBytes: 27225, materialsBytes: 3511, fieldCount: 14 };
    const text = await readReviewSkill(admin, await resolveReviewSkill(admin, SKILL));
    const s = settingsFor('100', 1).review;
    const round = estimateReview({ quotes: window.callPolicies, reviewers: s.reviewerModelIds, summary: s.summaryModelId, maxRounds: 1, maxBudgetUsd: '100',
      opinionTokens: s.opinionOutputTokens, summaryTokens: s.summaryOutputTokens, fieldCount: preview.fieldCount, snapshotBytes: preview.reportBytes + preview.materialsBytes,
      instructionBytes: { reviewer: Buffer.byteLength(text.reviewer + text.rubric) + 2048, summary: Buffer.byteLength(text.summary + text.rubric) + 2048 } });
    console.log('PLAN', JSON.stringify({ preview, worstPerRound: round.estimateUsd, current: await readFusionSettings(admin) }));
    return;
  }
  if (mode === 'settings') {
    const saved = await saveFusionSettings(admin, ACTOR, settingsFor(process.env.PROBE_BUDGET!), {});
    console.log('SETTINGS', JSON.stringify(saved.settings.review), JSON.stringify(saved.warnings));
    return;
  }
  if (mode === 'payg-extend' || mode === 'payg-restore') {
    const before = JSON.parse(readFileSync(homedir() + '/.graylum/fusion-review-pr4b/payg-before.json', 'utf8')).rows[0].value;
    let next = before;
    if (mode === 'payg-extend') next = paygHostSettings.parse({ ...before, profiles: before.profiles.map((p: { model: string; purposes: string[]; requestFormats: string[] }) =>
      ['google/gemini-3.8-flash', 'anthropic/claude-sonnet-5.5', 'openai/gpt-6-luna'].includes(p.model)
        ? { ...p, purposes: [...p.purposes, 'fusion_review', 'fusion_summary'], requestFormats: [...p.requestFormats, 'fusion-json-v1-stream'] } : p) });
    const r = await admin.from('system_settings').update({ value: next }).eq('key', 'runtime_payg_staging').select('key');
    console.log('PAYG', mode, r.error ? r.error.message : r.data?.length, JSON.stringify(next.profiles.map((p: { model: string; purposes: string[]; requestFormats: string[] }) => [p.model, p.purposes.length, p.requestFormats.length])));
    return;
  }
  if (mode === 'receipt') {
    const rows = (await admin.rpc('fusion_pending_financial_batch', { p_limit: 5 })).data as Array<{ run_id: string; call_id: string; actor_id: string; recovery: unknown }>;
    for (const item of rows) {
      const budget = createRuntimeBudget();
      const transport = stagingTransport(admin, parseStagingPolicy(item.recovery), budget);
      const lookup = transport.lookup.bind(transport);
      (transport as { lookup: typeof lookup }).lookup = async (...a: Parameters<typeof lookup>) => {
        try { const o = await lookup(...a); console.log('LOOKUP', JSON.stringify({ http: (o as { httpStatus?: number }).httpStatus, complete: (o as { complete?: boolean }).complete }));
          if (((o as { httpStatus?: number }).httpStatus ?? 0) >= 300) console.log('LOOKUP_BODY', decodeOpenRouterStreamObservation(o as never).toString('utf8').slice(0, 300));
          return o; }
        catch (e) { console.log('LOOKUP_ERR', e instanceof Error ? e.message : String(e)); throw e; }
      };
      const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor: async () => item.actor_id, adapter: transport, budget });
      try { const r = await billing.recoverReceipts(item.run_id, { timeoutMs: 8000, callId: item.call_id }); console.log('RECEIPT', item.call_id.slice(0, 8), String(JSON.stringify(r)).slice(0, 300)); }
      catch (e) { console.log('RECEIPT_ERR', item.call_id.slice(0, 8), e instanceof Error ? e.message : String(e)); }
    }
    return;
  }
  if (mode === 'why') {
    const id = process.env.PROBE_REVIEW!;
    const view = (await admin.rpc('fusion_review_read', { p_actor_id: ACTOR, p_review_id: id })).data;
    const src = (await admin.rpc('fusion_review_source', { p_actor_id: ACTOR, p_review_id: id })).data;
    const frozen = Object.fromEntries(Object.entries(view.materials as Record<string, Record<string, { value: unknown }>>).map(([k, f]) =>
      [k, Object.fromEntries(Object.entries(f).map(([fk, v]) => [fk, typeof v.value === 'string' ? v.value : '']))]));
    for (const call of view.calls.filter((c: { phase: string }) => c.phase === 'fusion_summary')) {
      const text = (await admin.rpc('fusion_call_output_read', { p_actor_id: ACTOR, p_call_id: call.callId })).data?.body as string;
      let parsed: { body?: string; steps?: Array<{ stepId: string; fields: Array<{ fieldId: string; changed: boolean }> }>; changeNotes?: unknown[] } = {};
      try { parsed = JSON.parse(text); } catch { console.log('WHY not json'); }
      const r = checkRevision(text, { previousBody: src.body, previousSteps: frozen, frozenSteps: frozen, declared: src.declared, sections: src.sections, maxCharacters: src.maxCharacters });
      const secs = parsed.body ? reportSections(parsed.body, src.sections, src.maxCharacters) : null;
      if (parsed.body) {
        const before = reportSections(src.body, src.sections, 1e9)!, now = reportSections(parsed.body, src.sections, 1e9);
        const idx = (t: string) => src.sections.indexOf(t);
        const changedSecs = now ? src.sections.filter((t: string) => now.get(t) !== before.get(t)).map(idx) : null;
        const notes = (parsed.changeNotes as Array<{ section: string; wordingOnly: boolean; fields?: Array<{ stepId: string; fieldId: string }> }> | undefined) ?? [];
        const changedFields = (parsed.steps ?? []).flatMap(st => st.fields.filter(f => f.changed).map(f => st.stepId + '.' + f.fieldId));
        if (now) for (const t of src.sections) { const x = before.get(t) ?? '', y = now.get(t) ?? ''; if (x === y) continue;
          const norm = (v: string) => v.replace(/\s+/g, '');
          let p = 0; while (p < x.length && x[p] === y[p]) p++;
          console.log('DIFF', idx(t), JSON.stringify({ lenBefore: [...x].length, lenAfter: [...y].length, wsOnly: norm(x) === norm(y), trimEqual: x.trim() === y.trim(), firstDiffAt: p })); }
        console.log('NOTES', JSON.stringify({ changedSections: changedSecs, notes: notes.map(n => ({ s: idx(n.section), exact: src.sections.includes(n.section), w: n.wordingOnly, f: (n.fields ?? []).map(f => f.stepId + '.' + f.fieldId) })), changedFields }));
      }
      console.log('WHY', JSON.stringify({ originalChars: [...src.body].length, result: r.ok ? 'ok' : (r as { reason: string }).reason, bodyChars: parsed.body ? [...parsed.body].length : null,
        sectionsOk: secs === null ? null : Boolean(secs), expectedSections: src.sections.length,
        headings: parsed.body ? parsed.body.split('\n').filter(l => l.startsWith('## ')).length : null,
        declaredFields: src.declared.reduce((n: number, d: { fieldIds: string[] }) => n + d.fieldIds.length, 0),
        outSteps: parsed.steps?.length, outFields: parsed.steps?.reduce((n, st) => n + st.fields.length, 0),
        changed: parsed.steps?.reduce((n, st) => n + st.fields.filter(f => f.changed).length, 0), notes: parsed.changeNotes?.length }));
    }
    return;
  }
  if (mode === 'events') {
    const { events, ended } = await reviewFlow({ admin, actorId: ACTOR }).events(process.env.PROBE_REVIEW!);
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const text = JSON.stringify(events);
    const longest = Math.max(...events.flatMap(e => Object.values(e).filter((v): v is string => typeof v === 'string').map(v => [...v].length)));
    console.log('EVENTS', JSON.stringify({ ended, total: events.length, order: [...new Set(events.map(e => e.type))], counts,
      modelNameLeak: /claude|gemini|gpt|sonnet|luna|anthropic|google|openai/i.test(text), longestText: longest,
      ids: new Set(events.map(e => e.id)).size === events.length,
      disagreements: events.filter(e => e.type === 'disagreement').map(e => ({ d: e.decision, keep: e.keep, change: e.change })),
      ready: events.find(e => e.type === 'revision_ready') && { ...events.find(e => e.type === 'revision_ready'), revisionId: undefined } }));
    return;
  }
  if (mode === 'clear') {
    // Same call as the admin endpoint fusionSettings.clearBreaker (the test account is an administrator).
    const r = await admin.rpc('fusion_review_breaker_clear', { p_admin_id: ACTOR, p_source_version_id: VERSION,
      p_reason: 'PR-4b 上一轮真实模型测试的 3 次修订失败（旧版评审 Skill），新版本测试前解除；总控 2026-10-14 同意用标记代替删除' });
    console.log('CLEAR', r.error ? 'error ' + r.error.message : JSON.stringify(r.data));
    return;
  }
  if (mode === 'recover') {
    console.log('RECOVER', JSON.stringify(await recoverFusionFinancials(admin, { timeLimitMs: 40_000 })));
    return;
  }
  if (mode === 'restore') {
    const r = await admin.from('system_settings').delete().eq('key', 'fusion_settings');
    console.log('RESTORE', r.error ? 'error ' + r.error.message : 'deleted', JSON.stringify(await readFusionSettings(admin)));
    return;
  }
  // run: one complete review, driven exactly like the tRPC router (one budget per request).
  const { role, s } = await userSession(k.service);
  const user = createClient(URL_, k.anon, { auth: { persistSession: false, autoRefreshToken: false } });
  await user.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  const window = await loadStagingPolicy(admin as unknown as BillingRpc, ACTOR, {});
  const flowFor = () => {
    const budget = createRuntimeBudget();
    const actor = runtimeActor(user.auth, ACTOR, budget, null);
    const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor, adapter: stagingTransport(admin, window, budget), budget });
    // Local run has no staging Redis; the per-dispatch rate limit is admitted here (unit-tested separately).
    const dispatchOnce = billing.dispatchOnce.bind(billing);
    (billing as { dispatchOnce: typeof dispatchOnce }).dispatchOnce = async (...a: Parameters<typeof dispatchOnce>) => {
      const d = await dispatchOnce(...a);
      const o = d.observation as { httpStatus?: number; complete?: boolean } | undefined;
      console.log('DISPATCH', JSON.stringify({ dispatched: d.dispatched, notStarted: d.transportNotStarted, rejected: d.providerRejected,
        pendingReceipt: Boolean(d.pendingReceipt), http: o?.httpStatus, complete: o?.complete }));
      if (o && (o.httpStatus ?? 0) >= 300) { try { console.log('ERRBODY', decodeOpenRouterStreamObservation(d.observation!).toString('utf8').slice(0, 400)); } catch { console.log('ERRBODY undecodable'); } }
      else if (o) { try { const raw = decodeOpenRouterStreamObservation(d.observation!).toString('utf8');
        const lines = raw.split('\n').filter(l => l.startsWith('data:'));
        const last = lines.slice(-3).map(l => l.slice(0, 160).replace(/"content":"[^"]*"/g, '"content":"…"'));
        console.log('STREAM', JSON.stringify({ bytes: raw.length, dataLines: lines.length, hasError: /"error"/.test(raw), tail: last })); } catch (e) { console.log('STREAM undecodable', e instanceof Error ? e.message : ''); } }
      return d;
    };
    const executor = fusionExecutor({ billing, admin, actorId: ACTOR, callGate: async () => ({ ok: true }), budget });
    const revisions = reportRevisionService(user, admin);
    return reviewFlow({ admin, actorId: ACTOR, executor, env: {},
      propose: async input => ({ revisionId: (await revisions.propose(input)).revisionId }) });
  };
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  const t0 = Date.now();
  if (process.env.PROBE_STOP) { const r = await flowFor().stop(process.env.PROBE_STOP); console.log('STOPPED', JSON.stringify({ state: r.state ?? (r as { review?: { state: string } }).review?.state })); return; }
  let reviewId: string = state.reviewId;
  if (!reviewId || process.env.PROBE_NEW === '1') {
    const started = await flowFor().start({ requestId: randomUUID(), draftId: DRAFT, sourceVersionId: VERSION });
    reviewId = started.reviewId;
    console.log('START', JSON.stringify({ role, reviewId, config: { ...started.config, skill: undefined } }));
    writeFileSync(STATE, JSON.stringify({ reviewId }));
  }
  for (let step = 0; step < 12; step++) {
    const listed = await admin.rpc('fusion_review_admin_list', { p_limit: 100 });
    if (listed.error) throw new Error('spend check unavailable ' + listed.error.message);
    const total = (listed.data as Array<{ actorId: string; costUsd: number | string }>).filter(r => r.actorId === ACTOR)
      .reduce((n, r) => n + Number(r.costUsd), 0) - Number(process.env.PROBE_SPENT_BASE ?? 0);
    console.log('SPENT', total.toFixed(4));
    if (total > 0.8) { console.log('STOP_BUDGET'); await flowFor().stop(reviewId); break; }
    const next = await flowFor().continue(reviewId);
    const v = next.review;
    console.log('STEP', JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), state: v.state, round: v.round, phase: v.phase, outcome: v.outcome,
      revisionId: v.revisionId, waiting: next.waiting, toDispatch: next.calls.map(c => c.modelId) }));
    const todo = next.calls.filter(c => !c.dispatched);
    if (!todo.length && next.waiting === 'calls') { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (!next.calls.length) { if (['running', 'paused'].includes(v.state) && !next.waiting) continue; break; }
    await Promise.all(todo.map(async c => {
      const started = Date.now();
      try { const r = await flowFor().dispatch(reviewId, c.callId, () => {});
        console.log('CALL', JSON.stringify({ model: c.modelId, phase: c.phase, ms: Date.now() - started, state: (r as { state?: string }).state, reason: (r as { reason?: string }).reason, verdict: (r as { verdict?: string }).verdict, chars: (r as { text?: string }).text?.length })); }
      catch (e) { console.log('CALL_ERR', JSON.stringify({ model: c.modelId, phase: c.phase, error: e instanceof Error ? e.message : 'unknown' })); }
    }));
  }
}, 900_000);
