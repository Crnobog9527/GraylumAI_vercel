/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {askCategories, type AskCategory} from './classify.ts';
import type {ProbeConfig} from './config.ts';
import type {TrialKind, TrialResult} from './trial.ts';

/** Owner decision 2026-09-28 for ask_question. */
export const ASK_PASS = {minCorrect: 0.9, maxMalformed: 0.03, minTrials: 30};

export type Stats = {n: number; median?: number; p90?: number};
export function stats(values: Array<number | undefined>): Stats {
  const sorted = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return {n: 0};
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const p90 = sorted[Math.ceil(sorted.length * 0.9) - 1]!;
  return {n: sorted.length, median: Math.round(median * 10) / 10, p90: Math.round(p90 * 10) / 10};
}

const tally = (values: string[]) => values.reduce<Record<string, number>>((counts, value) => {
  counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}, {});

/** Timings come only from trials that ran to the end; others are counted, not hidden. */
function kindSummary(trials: TrialResult[]) {
  const measured = trials.filter(trial => !trial.stop && trial.calls.some(call => call.status === 'ok'));
  return {
    trials: trials.length,
    measured: measured.length,
    sdkErrors: trials.filter(trial => trial.stop === 'sdk_error').length,
    firstContentMs: stats(measured.map(trial => trial.firstContentMs)),
    firstVisibleMs: stats(measured.map(trial => trial.firstVisibleMs)),
    firstSdkTextMs: stats(measured.map(trial => trial.firstSdkTextMs)),
    totalMs: stats(measured.map(trial => trial.totalMs)),
    charsPerSecond: stats(measured.map(trial => trial.charsPerSecond)),
    contentChars: stats(measured.map(trial => trial.contentChars)),
  };
}

function askSummary(trials: TrialResult[]) {
  const counts = Object.fromEntries(askCategories.map(category => [category, 0])) as Record<AskCategory, number>;
  for (const trial of trials) if (trial.outcome) counts[trial.outcome.category] += 1;
  // Only trials where the provider actually answered can judge the model.
  const answered = counts.correct + counts.malformed + counts.text_question + counts.no_question + counts.turn_not_ended;
  const correctRate = answered ? counts.correct / answered : undefined;
  const malformedRate = answered ? counts.malformed / answered : undefined;
  const called = trials.filter(trial => trial.outcome?.toolCalled && trial.outcome.argsValid);
  const verdict = answered < ASK_PASS.minTrials ? 'insufficient_trials'
    : correctRate! >= ASK_PASS.minCorrect && malformedRate! <= ASK_PASS.maxMalformed ? 'pass' : 'fail';
  return {
    ...kindSummary(trials), counts, answered, correctRate, malformedRate, verdict,
    turnEndedAfterValidCall: {ended: called.filter(trial => trial.outcome?.turnEnded).length, total: called.length},
    textBeforeTool: trials.filter(trial => trial.outcome?.textBeforeTool).length,
  };
}

export function summarize(configs: ProbeConfig[], results: TrialResult[]) {
  return configs.map(config => {
    const mine = results.filter(result => result.configId === config.id);
    const of = (kind: TrialKind) => mine.filter(result => result.kind === kind);
    const calls = mine.flatMap(result => result.calls);
    const cost = calls.reduce((sum, call) => sum + (call.costUsd ?? call.boundUsd), 0);
    return {
      configId: config.id, model: config.model, route: config.route, effort: config.effort,
      ask: askSummary(of('ask')),
      text: kindSummary(of('text')),
      reference: {...kindSummary(of('reference')), readsPerTrial: stats(of('reference').map(trial => trial.referenceReads))},
      reasoning: {
        trialsWithReasoning: mine.filter(result => result.reasoningSeen).length,
        reasoningTokens: mine.reduce((sum, result) => sum + (result.reasoningTokens ?? 0), 0),
      },
      reportedProviders: [...new Set(calls.map(call => call.facts.provider).filter(Boolean))],
      calls: {sent: calls.length, ...tally(calls.map(call => call.status))},
      httpStatuses: tally(calls.map(call => String(call.httpStatus ?? 'none'))),
      errorCodes: tally(calls.map(call => call.errorCode).filter((code): code is string => Boolean(code))),
      stops: tally(mine.map(result => result.stop).filter((stop): stop is NonNullable<TrialResult['stop']> => Boolean(stop))),
      costUsd: Math.round(cost * 1e9) / 1e9,
      providerReportedUsd: Math.round(calls.reduce((sum, call) => sum + (call.providerCostUsd ?? 0), 0) * 1e9) / 1e9,
      costDisagreements: calls.filter(call => call.costDisagreement).length,
      costSources: tally(calls.map(call => call.costSource ?? 'upper_bound')),
    };
  });
}
export type ConfigSummary = ReturnType<typeof summarize>[number];

const ms = (value: Stats) => value.n ? `${value.median} / ${value.p90} (n=${value.n})` : '-';
const pct = (value: number | undefined) => value === undefined ? '-' : (value * 100).toFixed(1) + '%';

/** Markdown table for the PR or the controller. Ids and numbers only. */
export function summaryMarkdown(rows: ConfigSummary[], totals: {calls: number; costUsd: number; mode: string; stop?: string}) {
  const lines = [
    `# AC-0b probe summary (${totals.mode})`, '',
    `Provider calls: ${totals.calls}; spend: $${totals.costUsd.toFixed(6)}${totals.stop ? '; stopped: ' + totals.stop : ''}`, '',
    '## ask_question', '',
    '| config | answered | correct | malformed | text question | no question | turn not ended | rejected | unknown | verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.configId} | ${row.ask.answered} | ${row.ask.counts.correct} (${pct(row.ask.correctRate)}) | ` +
      `${row.ask.counts.malformed} (${pct(row.ask.malformedRate)}) | ${row.ask.counts.text_question} | ${row.ask.counts.no_question} | ` +
      `${row.ask.counts.turn_not_ended} | ${row.ask.counts.provider_rejected} | ${row.ask.counts.unknown} | ${row.ask.verdict} |`),
    '', '## Latency and speed (median / p90 ms; chars per second median / p90)', '',
    '| config | kind | measured / trials | sdk errors | first content | first visible | total | chars/s |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.flatMap(row => (['ask', 'text', 'reference'] as const).filter(kind => row[kind].trials).map(kind =>
      `| ${row.configId} | ${kind} | ${row[kind].measured} / ${row[kind].trials} | ${row[kind].sdkErrors} | ` +
      `${ms(row[kind].firstContentMs)} | ${ms(row[kind].firstVisibleMs)} | ${ms(row[kind].totalMs)} | ${ms(row[kind].charsPerSecond)} |`)),
    '', '## Calls and cost', '',
    '| config | route reported | calls | statuses | reasoning seen | booked (USD) | provider-reported (USD) | cost source |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.configId} | ${row.reportedProviders.join(', ') || '-'} | ${row.calls.sent} | ` +
      `${JSON.stringify(row.httpStatuses)} | ${row.reasoning.trialsWithReasoning} | ${row.costUsd.toFixed(6)} | ` +
      `${row.providerReportedUsd.toFixed(6)} | ${JSON.stringify(row.costSources)} |`),
    '',
    'Booked cost is the larger of the provider-reported cost and both token counts at max_price (about twice the listed',
    'price), or the full bound when neither is available or the outcome is unknown; caps and the ledger use the booked cost.',
    'text_question / no_question use a question-mark heuristic; review results.jsonl for step-completion labels.',
  ];
  return lines.join('\n') + '\n';
}
