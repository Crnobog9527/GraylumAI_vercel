/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  DECISIONS, type AdoptChoice, type AdoptProposed, type AdoptRecorded, type DecisionKey, type DetailIssue, type DetailSection, type JuryDetail,
  type Seat, type Verdict,
} from './jury-events';

/**
 * Chapter-by-chapter choice between the revision and the original (Owner 2026-10-14), shaped after fusionReview.adopt.
 * Only changed chapters are chosen; unchanged ones keep the original. Linked chapters share a changed field and always
 * take the same choice. Adopting a wording-only chapter needs the user's confirmation that no positioning fact changed.
 */
export type Use = AdoptChoice['use'];
export type ChoiceState = Record<string, { use?: Use; confirmed?: boolean }>;

export const choosable = (sections: readonly DetailSection[]) => sections.filter(item => item.changed);

/** The chapter and every chapter linked to it, following links both ways. */
export function linkedGroup(sections: readonly DetailSection[], section: string): string[] {
  const group = new Set([section]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of sections) {
      const touches = group.has(item.section) || item.linkedSections.some(link => group.has(link));
      for (const name of touches ? [item.section, ...item.linkedSections] : []) {
        if (!group.has(name)) { group.add(name); grew = true; }
      }
    }
  }
  return sections.map(item => item.section).filter(name => group.has(name));
}

export function setUse(state: ChoiceState, sections: readonly DetailSection[], section: string, use: Use): ChoiceState {
  const next = { ...state };
  for (const name of linkedGroup(sections, section)) next[name] = { ...next[name], use };
  return next;
}

export function setConfirmed(state: ChoiceState, section: string, confirmed: boolean): ChoiceState {
  return { ...state, [section]: { ...state[section], confirmed } };
}

export function needsConfirm(section: DetailSection, state: ChoiceState): boolean {
  return section.wordingOnly && state[section.section]?.use === 'revised' && !state[section.section]?.confirmed;
}

export function chosenCount(state: ChoiceState, sections: readonly DetailSection[]): number {
  return choosable(sections).filter(item => state[item.section]?.use && !needsConfirm(item, state)).length;
}

export const isComplete = (state: ChoiceState, sections: readonly DetailSection[]) =>
  chosenCount(state, sections) === choosable(sections).length;

export function toChoices(state: ChoiceState, sections: readonly DetailSection[]): AdoptChoice[] {
  return choosable(sections).map(item => {
    const use = state[item.section]?.use ?? 'original';
    return item.wordingOnly && use === 'revised' ? { section: item.section, use, confirmedNoFactChange: true } : { section: item.section, use };
  });
}

const STEP_TITLE: Record<string, string> = {
  audience: '受众画像', platform: '平台选择', content: '内容支柱', monetization: '变现路径', plan: '30 天行动',
};
const FIELD_TITLE: Record<string, string> = {
  core: '核心受众', secondary: '同步发布的平台', pillars: '三个内容支柱', firstStep: '第一步怎么赚钱', cadence: '更新节奏',
};
/** Steps built on the changed ones: confirmed together with them, values unchanged (shape of R14's cascade). */
const CASCADE: AdoptProposed['diff']['cascade'] = [
  { stepId: 'topics', stepTitle: '第一周选题', fields: [
    { fieldId: 'topicList', fieldTitle: '选题清单', before: { value: '按原定位生成的 7 个选题', status: 'confirmed' },
      after: { value: '按原定位生成的 7 个选题', status: 'confirmed' } },
  ] },
];

/**
 * What the prototype pretends fusionReview.adopt returned: with an adopted chapter, a proposal (R14's field diff and
 * cascade, nothing changed yet); with every chapter kept, the choice is simply recorded.
 */
export function mockPropose(sections: readonly DetailSection[], choices: readonly AdoptChoice[]): AdoptProposed | AdoptRecorded {
  const adopted = choices.filter(item => item.use === 'revised').map(item => item.section);
  const kept = choices.filter(item => item.use === 'original').map(item => item.section);
  if (adopted.length === 0) return { state: 'recorded', versionId: null, adopted, kept };
  const seen = new Set<string>();
  const changes = sections.filter(item => adopted.includes(item.section)).flatMap(item => item.fields)
    .filter(item => !seen.has(`${item.stepId}.${item.fieldId}`) && Boolean(seen.add(`${item.stepId}.${item.fieldId}`)))
    .map(item => ({
      stepId: item.stepId, stepTitle: STEP_TITLE[item.stepId] ?? item.stepId, fieldId: item.fieldId,
      fieldTitle: FIELD_TITLE[item.fieldId] ?? item.fieldId,
      before: { value: item.before, status: 'confirmed' }, after: { value: item.after, status: 'confirmed' },
    }));
  return {
    state: 'proposed', revisionId: 'mock-revision', diff: { changes, cascade: changes.length > 0 ? CASCADE : [] },
    diffHash: `mock-${adopted.length}-${changes.length}`, adopted, kept,
  };
}

/** fusionReview.confirmAdoption: apply makes a new formal version, decline changes nothing. */
export function mockConfirm(proposal: AdoptProposed, decision: 'apply' | 'decline'): AdoptRecorded {
  return { state: 'recorded', versionId: decision === 'apply' ? 'mock-version' : null, adopted: proposal.adopted, kept: proposal.kept };
}

/** fusionReview.adopt refusal codes, in plain words. */
export const ADOPT_ERROR_LABEL: Record<string, string> = {
  FUSION_ADOPTION_INCOMPLETE: '还有改动过的章节没有选，请每章都选一下。',
  FUSION_ADOPTION_INVALID: '选择没有提交成功，请刷新页面后再选一次。',
  FUSION_ADOPTION_CONFIRM_REQUIRED: '只改了表述的章节，采用前要先勾选「确认不改变定位事实」。',
  FUSION_ADOPTION_LINKED: '联动的章节要选成一样，请再检查一下。',
  FUSION_ADOPTION_STALE: '内容有更新，请重新查看后再确认。',
  FUSION_REVIEW_ADOPTED: '这次评审已经选过了，下面是当时的选择。',
  REPORT_REVISION_STALE: '评审之后你改过草稿，这份修订稿已经作废。你的草稿没有变化，可以对新草稿重新发起评审。',
};
export const adoptErrorLabel = (code: string) => ADOPT_ERROR_LABEL[code] ?? '选择没有提交成功，请稍后再试。';

/* ---- read-outs for the result page ---- */

/** Each reviewer's latest verdict per key decision (round 2 if it gave a usable one, else round 1). */
export function finalVerdicts(detail: JuryDetail): Record<DecisionKey, Partial<Record<Seat, Verdict>>> {
  const result = Object.fromEntries(DECISIONS.map(key => [key, {}])) as Record<DecisionKey, Partial<Record<Seat, Verdict>>>;
  for (const { seat, rounds } of detail.seats) {
    for (const round of rounds) {
      if (round.status !== 'usable') continue;
      for (const item of round.decisions ?? []) result[item.decision][seat] = item.verdict;
    }
  }
  return result;
}

export function splitDecisions(detail: JuryDetail): DecisionKey[] {
  return DECISIONS.filter(key => detail.seats.some(({ rounds }) => {
    const first = rounds.find(round => round.round === 1)?.decisions?.find(item => item.decision === key)?.verdict;
    return detail.seats.some(other => other.rounds.find(round => round.round === 1)?.decisions
      ?.find(item => item.decision === key)?.verdict !== first);
  }));
}

/** When there is no ruling (the revision failed): every usable issue, grouped by chapter in report order. */
export function issuesByChapter(detail: JuryDetail, order: readonly string[]): { section: string; items: (DetailIssue & { seat: Seat })[] }[] {
  const all = detail.seats.flatMap(({ seat, rounds }) => rounds.filter(round => round.status === 'usable')
    .flatMap(round => (round.issues ?? []).map(issue => ({ ...issue, seat }))));
  return order.map(section => ({ section, items: all.filter(item => item.location === section) })).filter(group => group.items.length > 0);
}

export function issueCount(detail: JuryDetail): number {
  return detail.seats.reduce((sum, { rounds }) => sum + rounds.reduce((inner, round) => inner + (round.issues?.length ?? 0), 0), 0);
}
