/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Probe-local offline preparation; application code must never import this file.
import {createHmac} from 'node:crypto';
import type {TrialResult} from './trial.ts';

export type BlindReviewItem = {
  opaqueId: string;
  scenarioId: string;
  kind: TrialResult['kind'];
  index: number;
  publicText: string;
  toolArguments: Array<{name: string; arguments: string}>;
};
export type PrivateBlindMapping = Pick<BlindReviewItem, 'opaqueId' | 'scenarioId' | 'kind' | 'index'> & {
  configId: string;
};
const identity = (trial: TrialResult) => JSON.stringify([trial.scenarioId, trial.kind, trial.index]);

/** Pure offline transformation of one or two complete 40-trial configurations.
 * Supply a fresh 32-byte random seed, e.g. randomBytes(32), from the caller.
 * The function itself performs no filesystem, environment, key or network reads.
 *
 * Give reviewers ONLY `items`; keep `privateMapping` and the seed separately,
 * never in the review attachment or its filename. Reviewers must lock their
 * judgments by opaqueId before the operator reveals privateMapping. No semantic
 * PASS is inferred here. Failed/empty samples remain among the review items.
 * With one configuration the items still hide its identity, cost and latency.
 */
export function blindReview(
  configurations: readonly (readonly TrialResult[])[],
  randomSeed: Uint8Array,
): {items: BlindReviewItem[]; privateMapping: PrivateBlindMapping[]} {
  if (randomSeed.byteLength !== 32) throw new Error('PROBE_BLIND_RANDOM_SEED_REQUIRED');
  if (configurations.length !== 1 && configurations.length !== 2) throw new Error('PROBE_BLIND_CONFIGURATION_COUNT');
  for (const trials of configurations) {
    if (trials.length !== 40 || new Set(trials.map(trial => trial.configId)).size !== 1 || !trials[0]!.configId ||
        trials.some(trial => !trial.scenarioId || !Number.isSafeInteger(trial.index) || trial.index < 0) ||
        new Set(trials.map(identity)).size !== 40) throw new Error('PROBE_BLIND_INCOMPLETE_CONFIGURATION');
  }
  if (configurations.length === 2 && (configurations[0]![0]!.configId === configurations[1]![0]!.configId ||
      JSON.stringify(configurations[0]!.map(identity).sort()) !==
      JSON.stringify(configurations[1]!.map(identity).sort()))) throw new Error('PROBE_BLIND_CONFIGURATION_MISMATCH');
  const derive = (label: string, position: number) =>
    createHmac('sha256', randomSeed).update(label + ':' + position).digest('hex');
  const privateMapping: PrivateBlindMapping[] = [];
  const entries = configurations.flatMap(trials => trials).map((trial, position) => {
    const opaqueId = derive('id', position);
    const {scenarioId, kind, index} = trial;
    privateMapping.push({opaqueId, configId: trial.configId, scenarioId, kind, index});
    const item: BlindReviewItem = {
      opaqueId, scenarioId, kind, index,
      publicText: trial.calls.map(call => call.facts.content).join(''),
      toolArguments: trial.calls.flatMap(call => call.facts.toolCalls.map(tool =>
        ({name: tool.name, arguments: tool.arguments}))),
    };
    return {order: derive('order', position), item};
  });
  entries.sort((left, right) => left.order.localeCompare(right.order));
  return {items: entries.map(entry => entry.item), privateMapping};
}
